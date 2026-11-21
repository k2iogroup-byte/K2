import { createHash, randomUUID } from 'node:crypto';

import {
  addDecimals,
  canonicalDecimal,
  DecimalError,
  decimalGreaterThan,
  decimalLessThan,
  decimalsEqual,
  divideByInt,
  multiplyDecimals,
  subtractDecimals,
} from '@k2/shared';
import type { Pool, PoolClient } from 'pg';

import { DEFAULT_STALE_AFTER_MS } from '../market-data/engine.js';
import { liquiditySource, type LiquidityTake, takeLiquidity } from './liquidity.js';
import {
  ClosedEquityCalendar,
  FailClosedRiskAuthorizer,
  type RiskAuthorizer,
  type RiskDecision,
  type SessionCalendar,
} from './risk-authorizer.js';
import type { TradingLock } from './singleton.js';
import { quotePriceToUsd, settlesAsUsd } from './usdt-usd.js';

const MONEY = 4;
/**
 * Opening commission on buy notional. Founder approval 2026-11-21.
 * Closing commission stays zero. The rate applies only when the market is in scope.
 */
const OPENING_COMMISSION_PCT = '0.5000';

export class TradingNotFoundError extends Error {
  readonly statusCode = 404;
  constructor() {
    super('Trading account not found');
    this.name = 'TradingNotFoundError';
  }
}

export class TradingConflictError extends Error {
  readonly statusCode = 409;
  constructor(message = 'Idempotency key was reused with a different request') {
    super(message);
    this.name = 'TradingConflictError';
  }
}

export type ExecutableQuote = {
  quoteUpdateId: string;
  bid: string;
  ask: string;
  bidSize: string;
  askSize: string;
  /** Local receive time. Not an exchange timestamp. */
  receivedAt: Date;
  feedState: 'LIVE' | 'DEGRADED' | 'STALE' | 'DISCONNECTED';
  priceOrigin: 'TEST_FIXTURE' | 'VENDOR';
};

export type OrderInput = {
  accountId: string;
  userId: string;
  instrumentId: string;
  clientOrderId: string;
  idempotencyKey: string;
  side: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT';
  quantity: string;
  limitPrice: string | null;
  quote: ExecutableQuote | null;
};

export type TradingOrderResult = {
  orderId: string | null;
  state: string;
  rejectReason: string | null;
  filledQuantity: string;
  cash: string | null;
  executionId: string | null;
};

export type PositionView = {
  quantity: string;
  reservedSell: string;
  status: string;
};

type InstrumentRow = {
  market: string;
  quote_asset: string | null;
  trading_status: string;
  price_scale: number;
  quantity_scale: number;
};

type PositionRow = {
  id: string;
  quantity: string;
  reserved_sell: string;
  status: string;
  cost_basis: string;
  average_entry: string;
};

type StoredCommand = {
  user_id: string;
  request_hash: string;
  response: TradingOrderResult;
};

export type TradingServiceOptions = {
  authorizer?: RiskAuthorizer;
  calendar?: SessionCalendar;
  fillsEnabled?: boolean;
  lock?: TradingLock;
};

export class TradingService {
  private readonly authorizer: RiskAuthorizer;
  private readonly calendar: SessionCalendar;
  private readonly fillsEnabled: boolean;
  private readonly lock: TradingLock | null;

  constructor(
    private readonly pool: Pool,
    options: TradingServiceOptions = {},
  ) {
    this.authorizer = options.authorizer ?? new FailClosedRiskAuthorizer();
    this.calendar = options.calendar ?? new ClosedEquityCalendar();
    this.fillsEnabled = options.fillsEnabled ?? false;
    this.lock = options.lock ?? null;
  }

  async submit(input: OrderInput): Promise<TradingOrderResult> {
    if (input.quote && this.fillsEnabled && this.tradingOpen()) {
      await this.drainQueue(input.instrumentId, input.quote);
    }
    try {
      return await this.transaction(async (client) => this.submitLocked(client, input));
    } catch (error) {
      if (!isUniqueViolation(error, 'trading_commands_pkey')) throw error;
      const stored = await this.readCommand(input.idempotencyKey);
      if (
        !stored ||
        stored.user_id !== input.userId ||
        stored.request_hash !== requestHash(input)
      ) {
        throw new TradingConflictError();
      }
      return stored.response;
    }
  }

  /** Fill resting orders for this instrument in accept_sequence order. */
  async applyQuote(instrumentId: string, quote: ExecutableQuote): Promise<readonly string[]> {
    if (!this.fillsEnabled || !this.tradingOpen()) return [];
    return this.drainQueue(instrumentId, quote);
  }

  async position(accountId: string, instrumentId: string): Promise<PositionView | null> {
    const result = await this.pool.query<PositionRow>(
      `SELECT id, quantity::text, reserved_sell::text, status, cost_basis::text, average_entry::text
       FROM positions WHERE account_id = $1 AND instrument_id = $2`,
      [accountId, instrumentId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      quantity: row.quantity,
      reservedSell: row.reserved_sell,
      status: row.status,
    };
  }

  /** A second copy of the same fill key must not change the position. */
  async reapplyFill(orderId: string): Promise<{ applied: boolean; quantity: string }> {
    return this.transaction(async (client) => {
      const order = await client.query<{
        account_id: string;
        instrument_id: string;
        quote_update_id: string;
        quantity: string;
        price: string;
        notional: string;
        commission: string;
        received_at: Date;
        price_origin: string;
      }>(
        `SELECT orders.account_id, orders.instrument_id, executions.quote_update_id,
                executions.quantity::text, executions.price::text, executions.notional::text,
                executions.commission::text, executions.received_at, executions.price_origin
         FROM orders
         JOIN executions ON executions.order_id = orders.id
         WHERE orders.id = $1
         ORDER BY executions.sequence_no
         LIMIT 1
         FOR UPDATE OF orders`,
        [orderId],
      );
      const row = order.rows[0];
      if (!row) throw new TradingNotFoundError();
      const inserted = await client.query(
        `INSERT INTO executions (
           order_id, account_id, instrument_id, sequence_no, quantity, price, notional, commission,
           quote_update_id, received_at, price_origin, live_market_data, execution_venue
         ) VALUES (
           $1, $2, $3, 99, $4, $5, $6, $7, $8, $9, $10, false, 'K2_SIMULATION'
         )
         ON CONFLICT ON CONSTRAINT executions_fill_key DO NOTHING
         RETURNING id`,
        [
          orderId,
          row.account_id,
          row.instrument_id,
          row.quantity,
          row.price,
          row.notional,
          row.commission,
          row.quote_update_id,
          row.received_at,
          row.price_origin,
        ],
      );
      const position = await client.query<{ quantity: string }>(
        `SELECT quantity::text FROM positions
         WHERE account_id = $1 AND instrument_id = $2`,
        [row.account_id, row.instrument_id],
      );
      return {
        applied: (inserted.rowCount ?? 0) > 0,
        quantity: position.rows[0]?.quantity ?? '0',
      };
    });
  }

  private async submitLocked(client: PoolClient, input: OrderInput): Promise<TradingOrderResult> {
    const account = await client.query<{ state: string; initial_capital: string }>(
      `SELECT state, initial_capital::text
       FROM trading_accounts
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [input.accountId, input.userId],
    );
    const locked = account.rows[0];
    if (!locked) throw new TradingNotFoundError();

    const stored = await this.readCommand(input.idempotencyKey, client);
    if (stored) {
      if (stored.user_id !== input.userId || stored.request_hash !== requestHash(input)) {
        throw new TradingConflictError();
      }
      return stored.response;
    }

    const instrumentResult = await client.query<InstrumentRow>(
      `SELECT market, quote_asset, trading_status, price_scale, quantity_scale
       FROM instruments WHERE id = $1`,
      [input.instrumentId],
    );
    const instrument = instrumentResult.rows[0];
    if (!instrument || instrument.trading_status !== 'TRADABLE') {
      return this.persistReject(
        client,
        input,
        locked.initial_capital,
        instrument,
        'INSTRUMENT_NOT_TRADABLE',
      );
    }

    if (this.isRiskReducingSell(input, locked.state, instrument)) {
      const position = await this.lockPosition(client, input.accountId, input.instrumentId);
      const positionReject = await this.positionRule(client, input, instrument, position);
      if (positionReject) {
        return this.persistReject(
          client,
          input,
          locked.initial_capital,
          instrument,
          positionReject,
        );
      }
      if (this.lock && !this.lock.fillsAllowed()) {
        return this.persistReject(
          client,
          input,
          locked.initial_capital,
          instrument,
          'TRADING_LOCK_LOST',
        );
      }
      if (!this.fillsEnabled) {
        return this.persistReject(
          client,
          input,
          locked.initial_capital,
          instrument,
          'EXECUTION_DISABLED',
        );
      }
      return this.riskReducingSell(client, input, locked.initial_capital, instrument, position);
    }

    const reject = this.precheck(input, locked.state, instrument);
    if (reject)
      return this.persistReject(client, input, locked.initial_capital, instrument, reject);
    if (this.lock && !this.lock.fillsAllowed()) {
      return this.persistReject(
        client,
        input,
        locked.initial_capital,
        instrument,
        'TRADING_LOCK_LOST',
      );
    }

    const position = await this.lockPosition(client, input.accountId, input.instrumentId);
    const positionReject = await this.positionRule(client, input, instrument, position);
    if (positionReject) {
      return this.persistReject(client, input, locked.initial_capital, instrument, positionReject);
    }

    const decision = await this.authorizer.authorize({
      accountId: input.accountId,
      instrumentId: input.instrumentId,
      side: input.side,
      quantity: input.quantity,
    });
    if (decision.decision === 'REJECT') {
      return this.persistReject(
        client,
        input,
        locked.initial_capital,
        instrument,
        decision.reasonCode,
        decision,
      );
    }
    if (!this.fillsEnabled) {
      return this.persistReject(
        client,
        input,
        locked.initial_capital,
        instrument,
        'EXECUTION_DISABLED',
        decision,
      );
    }

    const scope = await client.query(
      'SELECT 1 FROM commission_market_scopes WHERE market = $1 LIMIT 1',
      [instrument.market],
    );
    if ((scope.rowCount ?? 0) === 0) {
      return this.persistReject(
        client,
        input,
        locked.initial_capital,
        instrument,
        'COMMISSION_SCOPE_UNRESOLVED',
        decision,
      );
    }

    return this.accept(client, input, locked.initial_capital, instrument, position, decision);
  }

  private isRiskReducingSell(input: OrderInput, state: string, instrument: InstrumentRow): boolean {
    return (
      input.side === 'SELL' &&
      state === 'ACTIVE' &&
      instrument.trading_status === 'TRADABLE' &&
      ((instrument.market === 'EQUITIES' && instrument.quote_asset === 'USD') ||
        (instrument.market === 'CRYPTO' && instrument.quote_asset === 'USDT'))
    );
  }

  private async riskReducingSell(
    client: PoolClient,
    input: OrderInput,
    initialCapital: string,
    instrument: InstrumentRow,
    position: PositionRow | null,
  ): Promise<TradingOrderResult> {
    if (!position) {
      return this.persistReject(client, input, initialCapital, instrument, 'INSUFFICIENT_POSITION');
    }
    const decision: RiskDecision = {
      decision: 'APPROVE',
      decisionId: randomUUID(),
      reasonCode: 'RISK_REDUCING',
      mode: 'RISK_REDUCING',
    };
    const stored = await client.query<{ feed_state: string; received_timestamp: Date }>(
      `SELECT feed_state, received_timestamp FROM quote_snapshots WHERE instrument_id = $1`,
      [input.instrumentId],
    );
    const quote = input.quote;
    const calendarOpen =
      instrument.market !== 'EQUITIES' ||
      this.calendar.equitySessionOpen(quote?.receivedAt ?? new Date());
    const feedFresh =
      quote !== null && quote.feedState === 'LIVE' && /^[0-9]+$/.test(quote.quoteUpdateId);
    if ((stored.rowCount ?? 0) === 0 && !quote) {
      const priced = { ...input, quote: this.entryQuote(position, instrument) };
      const result = await this.accept(
        client,
        priced,
        initialCapital,
        instrument,
        position,
        decision,
        'full',
      );
      if (result.orderId && result.rejectReason === null) {
        await this.auditClose(
          client,
          result.orderId,
          input.accountId,
          'ENTRY_FALLBACK',
          null,
          null,
        );
      }
      return result;
    }
    if (feedFresh && calendarOpen) {
      const result = await this.accept(
        client,
        input,
        initialCapital,
        instrument,
        position,
        decision,
        'book',
      );
      if (result.orderId && result.rejectReason === null) {
        const age = quoteAgeMs(quote);
        await this.auditClose(client, result.orderId, input.accountId, 'FRESH', age, age);
      }
      return result;
    }
    const placeholder = quote ?? this.entryQuote(position, instrument);
    const result = await this.accept(
      client,
      { ...input, quote: placeholder },
      initialCapital,
      instrument,
      position,
      decision,
      'defer',
    );
    if (result.orderId && result.state === 'OPEN') {
      await client.query(
        `INSERT INTO deferred_closes (order_id, position_id, account_id, instrument_id, quantity)
         VALUES ($1, $2, $3, $4, $5)`,
        [result.orderId, position.id, input.accountId, input.instrumentId, input.quantity],
      );
      await this.auditClose(
        client,
        result.orderId,
        input.accountId,
        'DEFERRED_FRESH',
        quote ? quoteAgeMs(quote) : null,
        null,
      );
    }
    return result;
  }

  private entryQuote(position: PositionRow, instrument: InstrumentRow): ExecutableQuote {
    const price = canonicalDecimal(position.average_entry, instrument.price_scale);
    return {
      quoteUpdateId: Date.now().toString(),
      bid: price,
      ask: price,
      bidSize: position.quantity,
      askSize: position.quantity,
      receivedAt: new Date(),
      feedState: 'DISCONNECTED',
      priceOrigin: 'TEST_FIXTURE',
    };
  }

  private async auditClose(
    client: PoolClient,
    orderId: string,
    accountId: string,
    basis: 'FRESH' | 'DEFERRED_FRESH' | 'ENTRY_FALLBACK',
    acceptanceAgeMs: number | null,
    fillAgeMs: number | null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO risk_reducing_audits (
         order_id, account_id, price_basis, quote_age_acceptance_ms, quote_age_fill_ms
       ) VALUES ($1, $2, $3, $4, $5)`,
      [orderId, accountId, basis, acceptanceAgeMs, fillAgeMs],
    );
  }

  private precheck(input: OrderInput, state: string, instrument: InstrumentRow): string | null {
    if (state !== 'ACTIVE') return 'ACCOUNT_NOT_TRADABLE';
    const quoteAsset = instrument.quote_asset;
    if (!quoteAsset || !cryptoOrEquitySettlement(instrument.market, quoteAsset)) {
      return 'QUOTE_CURRENCY_UNRESOLVED';
    }
    const quote = input.quote;
    if (instrument.market === 'EQUITIES') {
      const at = quote?.receivedAt ?? new Date();
      if (!this.calendar.equitySessionOpen(at)) return 'CALENDAR_UNCOVERED';
    }
    if (!quote || quote.feedState !== 'LIVE' || !/^[0-9]+$/.test(quote.quoteUpdateId)) {
      return 'FEED_UNAVAILABLE';
    }
    if (
      instrument.market === 'CRYPTO' &&
      Date.now() - quote.receivedAt.getTime() > DEFAULT_STALE_AFTER_MS.CRYPTO
    ) {
      return 'FEED_UNAVAILABLE';
    }
    try {
      canonicalDecimal(input.quantity, instrument.quantity_scale);
      quotePriceToUsd(quoteAsset, quote.bid, instrument.price_scale);
      quotePriceToUsd(quoteAsset, quote.ask, instrument.price_scale);
      canonicalDecimal(quote.bidSize, instrument.quantity_scale);
      canonicalDecimal(quote.askSize, instrument.quantity_scale);
      if (input.orderType === 'LIMIT') {
        if (!input.limitPrice) return 'INVALID_ORDER';
        quotePriceToUsd(quoteAsset, input.limitPrice, instrument.price_scale);
      }
    } catch (error) {
      if (error instanceof DecimalError) return 'INVALID_ORDER';
      throw error;
    }
    const bid = quotePriceToUsd(quoteAsset, quote.bid, instrument.price_scale);
    const ask = quotePriceToUsd(quoteAsset, quote.ask, instrument.price_scale);
    if (
      !decimalGreaterThan(input.quantity, '0', instrument.quantity_scale) ||
      !decimalGreaterThan(bid, '0', instrument.price_scale) ||
      !decimalGreaterThan(ask, '0', instrument.price_scale) ||
      decimalLessThan(ask, bid, instrument.price_scale)
    ) {
      return 'FEED_UNAVAILABLE';
    }
    return null;
  }

  private async positionRule(
    client: PoolClient,
    input: OrderInput,
    instrument: InstrumentRow,
    position: PositionRow | null,
  ): Promise<string | null> {
    const scale = instrument.quantity_scale;
    if (input.side === 'BUY') {
      if (
        position &&
        (decimalGreaterThan(position.quantity, '0', scale) ||
          decimalGreaterThan(position.reserved_sell, '0', scale))
      ) {
        return 'POSITION_ALREADY_OPEN';
      }
      const working = await client.query(
        `SELECT 1 FROM orders
         WHERE account_id = $1 AND instrument_id = $2
           AND state IN ('OPEN', 'PARTIALLY_FILLED')
         LIMIT 1`,
        [input.accountId, input.instrumentId],
      );
      if ((working.rowCount ?? 0) > 0) return 'POSITION_ALREADY_OPEN';
      return null;
    }
    if (!position) return 'INSUFFICIENT_POSITION';
    const available = subtractDecimals(position.quantity, position.reserved_sell, scale);
    if (decimalLessThan(available, canonicalDecimal(input.quantity, scale), scale)) {
      return 'INSUFFICIENT_POSITION';
    }
    return null;
  }

  private async accept(
    client: PoolClient,
    input: OrderInput,
    initialCapital: string,
    instrument: InstrumentRow,
    position: PositionRow | null,
    decision: RiskDecision,
    pricing: 'book' | 'full' | 'defer' = 'book',
  ): Promise<TradingOrderResult> {
    const rawQuote = input.quote;
    if (!rawQuote)
      return this.persistReject(
        client,
        input,
        initialCapital,
        instrument,
        'FEED_UNAVAILABLE',
        decision,
      );
    const priceScale = instrument.price_scale;
    const qtyScale = instrument.quantity_scale;
    const quoteAsset = instrument.quote_asset ?? 'USD';
    const quote = {
      ...rawQuote,
      bid: quotePriceToUsd(quoteAsset, rawQuote.bid, priceScale),
      ask: quotePriceToUsd(quoteAsset, rawQuote.ask, priceScale),
    };
    const quantity = canonicalDecimal(input.quantity, qtyScale);
    const touch = canonicalDecimal(input.side === 'BUY' ? quote.ask : quote.bid, priceScale);
    const displayed = canonicalDecimal(
      input.side === 'BUY' ? quote.askSize : quote.bidSize,
      qtyScale,
    );
    const limit = input.limitPrice
      ? quotePriceToUsd(quoteAsset, input.limitPrice, priceScale)
      : null;
    const marketable =
      input.orderType === 'MARKET' ||
      (input.side === 'BUY'
        ? !decimalLessThan(limit ?? touch, touch, priceScale)
        : !decimalGreaterThan(limit ?? touch, touch, priceScale));
    const reservePrice = input.orderType === 'LIMIT' && limit ? limit : touch;
    const fullCost = this.cashNeed(input.side, quantity, reservePrice, priceScale, qtyScale);
    const cash = await this.lockCash(client, input.accountId, initialCapital);
    const available = subtractDecimals(cash.cash, cash.reserved, MONEY);
    if (input.side === 'BUY' && decimalLessThan(available, fullCost, MONEY)) {
      return this.persistReject(
        client,
        input,
        initialCapital,
        instrument,
        'INSUFFICIENT_CASH',
        decision,
        cash.cash,
      );
    }

    if (this.lock && !this.lock.fillsAllowed()) {
      return this.persistReject(
        client,
        input,
        initialCapital,
        instrument,
        'TRADING_LOCK_LOST',
        decision,
        cash.cash,
      );
    }
    let taken: LiquidityTake | null = null;
    if (pricing === 'book' && marketable) {
      taken = await takeLiquidity(client, {
        instrumentId: input.instrumentId,
        source: liquiditySource(quote.priceOrigin),
        bookSide: input.side === 'BUY' ? 'ASK' : 'BID',
        price: touch,
        priceScale,
        quoteUpdateId: quote.quoteUpdateId,
        displayed,
        want: quantity,
        quantityScale: qtyScale,
      });
    }
    const fillQty =
      pricing === 'full' && marketable
        ? quantity
        : pricing === 'defer'
          ? zero(qtyScale)
          : (taken?.quantity ?? zero(qtyScale));
    if (
      pricing === 'book' &&
      input.orderType === 'MARKET' &&
      !decimalGreaterThan(fillQty, '0', qtyScale)
    ) {
      return this.persistReject(
        client,
        input,
        initialCapital,
        instrument,
        'NO_LIQUIDITY',
        decision,
      );
    }
    const unfilled = subtractDecimals(quantity, fillQty, qtyScale);
    const remainderRests =
      input.orderType === 'LIMIT' && decimalGreaterThan(unfilled, '0', qtyScale);
    const state = !decimalGreaterThan(fillQty, '0', qtyScale)
      ? 'OPEN'
      : decimalsEqual(fillQty, quantity, qtyScale)
        ? 'FILLED'
        : remainderRests
          ? 'PARTIALLY_FILLED'
          : 'CANCELLED';
    const fillPrice = touch;
    const filledNotional = decimalGreaterThan(fillQty, '0', qtyScale)
      ? multiplyDecimals(fillPrice, fillQty, priceScale, qtyScale, MONEY)
      : zero(MONEY);
    const filledFee = input.side === 'BUY' ? openingFee(filledNotional) : zero(MONEY);
    const remainderQty = remainderRests ? unfilled : zero(qtyScale);
    const remainderReserve =
      input.side === 'BUY' && decimalGreaterThan(remainderQty, '0', qtyScale)
        ? this.cashNeed('BUY', remainderQty, reservePrice, priceScale, qtyScale)
        : zero(MONEY);
    const openReserve = state === 'OPEN' && input.side === 'BUY' ? fullCost : remainderReserve;
    const sellReserved =
      input.side === 'SELL' && (state === 'OPEN' || state === 'PARTIALLY_FILLED')
        ? remainderQty === zero(qtyScale) && state === 'OPEN'
          ? quantity
          : remainderQty
        : zero(qtyScale);
    let nextCash = cash.cash;
    let nextReserved = cash.reserved;
    if (decimalGreaterThan(openReserve, '0', MONEY)) {
      nextReserved = addDecimals(nextReserved, openReserve, MONEY);
    }
    if (decimalGreaterThan(fillQty, '0', qtyScale)) {
      const spent = addDecimals(filledNotional, filledFee, MONEY);
      nextCash =
        input.side === 'BUY'
          ? subtractDecimals(nextCash, spent, MONEY)
          : addDecimals(nextCash, filledNotional, MONEY);
    }
    if (decimalLessThan(nextCash, '0', MONEY) || decimalLessThan(nextCash, nextReserved, MONEY)) {
      return this.persistReject(
        client,
        input,
        initialCapital,
        instrument,
        'INSUFFICIENT_CASH',
        decision,
        cash.cash,
      );
    }

    const order = await client.query<{ id: string }>(
      `INSERT INTO orders (
         account_id, user_id, instrument_id, client_order_id, side, order_type, state,
         quantity, filled_quantity, limit_price, cash_reserved, sell_reserved, reject_reason,
         risk_decision_id, quote_asset, price_origin, live_market_data, feed_state, received_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, NULL,
         $13, 'USD', $14, false, $15, $16
       ) RETURNING id`,
      [
        input.accountId,
        input.userId,
        input.instrumentId,
        input.clientOrderId,
        input.side,
        input.orderType,
        state,
        quantity,
        fillQty,
        limit,
        openReserve,
        sellReserved,
        decision.decisionId,
        quote.priceOrigin,
        quote.feedState,
        quote.receivedAt,
      ],
    );
    const orderId = order.rows[0]?.id;
    if (!orderId) throw new Error('order insert returned no id');
    await this.recordDecision(client, decision, orderId, input.accountId);
    await this.recordTransition(client, orderId, null, state, 'accept', input.userId);

    let executionId: string | null = null;
    if (decimalGreaterThan(fillQty, '0', qtyScale)) {
      executionId = await this.insertExecution(client, {
        orderId,
        input,
        instrumentId: input.instrumentId,
        fillQty,
        fillPrice,
        notional: filledNotional,
        fee: filledFee,
        quote,
      });
      await this.applyPosition(client, {
        input,
        instrument,
        position,
        fillQty,
        fillPrice,
        notional: filledNotional,
        executionId,
        sellReserved,
      });
      await this.outbox(client, input.accountId, executionId, filledNotional, filledFee);
      if (taken && decimalGreaterThan(taken.quantity, '0', qtyScale)) {
        await client.query(
          `INSERT INTO liquidity_allocations (
             execution_id, instrument_id, book_side, price, displayed_qty, consumed_before,
             take_qty, consumed_after, accept_sequence, quote_update_id
           )
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, accept_sequence, $9
           FROM orders WHERE id = $10`,
          [
            executionId,
            input.instrumentId,
            taken.bookSide,
            taken.price,
            taken.displayed,
            taken.consumedBefore,
            taken.quantity,
            taken.consumedAfter,
            taken.quoteUpdateId,
            orderId,
          ],
        );
      }
    } else if (
      input.side === 'SELL' &&
      decimalGreaterThan(sellReserved, '0', qtyScale) &&
      position
    ) {
      await client.query(
        `UPDATE positions
         SET reserved_sell = $2, updated_at = now()
         WHERE id = $1`,
        [position.id, addDecimals(position.reserved_sell, sellReserved, qtyScale)],
      );
    }
    await client.query(
      `UPDATE simulation_cash_projections
       SET cash = $2, reserved_cash = $3, event_sequence = event_sequence + 1, updated_at = now()
       WHERE account_id = $1`,
      [input.accountId, nextCash, nextReserved],
    );
    if (!decimalsEqual(nextCash, cash.cash, MONEY)) {
      await client.query(
        `INSERT INTO simulation_cash_movements (movement_key, account_id, amount)
         VALUES ($1, $2, $3)`,
        [`cash:${orderId}`, input.accountId, subtractDecimals(nextCash, cash.cash, MONEY)],
      );
    }
    const result: TradingOrderResult = {
      orderId,
      state,
      rejectReason: null,
      filledQuantity: fillQty,
      cash: nextCash,
      executionId,
    };
    await this.storeCommand(client, input, result);
    await this.event(client, input.accountId, 'order.accepted', result);
    return result;
  }

  private cashNeed(
    side: 'BUY' | 'SELL',
    quantity: string,
    price: string,
    priceScale: number,
    qtyScale: number,
  ): string {
    if (side === 'SELL') return zero(MONEY);
    const notional = multiplyDecimals(price, quantity, priceScale, qtyScale, MONEY);
    return addDecimals(notional, openingFee(notional), MONEY);
  }

  private async applyPosition(
    client: PoolClient,
    args: {
      input: OrderInput;
      instrument: InstrumentRow;
      position: PositionRow | null;
      fillQty: string;
      fillPrice: string;
      notional: string;
      executionId: string;
      sellReserved: string;
    },
  ): Promise<void> {
    const scale = args.instrument.quantity_scale;
    if (args.input.side === 'BUY') {
      const nextQty = args.position
        ? addDecimals(args.position.quantity, args.fillQty, scale)
        : args.fillQty;
      const nextCost = args.position
        ? addDecimals(args.position.cost_basis, args.notional, MONEY)
        : args.notional;
      const reopened = args.position?.status === 'CLOSED';
      if (!args.position) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO positions (
             account_id, instrument_id, status, quantity, reserved_sell, average_entry, cost_basis, opened_at
           ) VALUES ($1, $2, 'OPEN', $3, 0, $4, $5, now())
           RETURNING id`,
          [args.input.accountId, args.input.instrumentId, nextQty, args.fillPrice, nextCost],
        );
        const positionId = inserted.rows[0]?.id;
        if (!positionId) throw new Error('position insert returned no id');
        await this.positionEvent(
          client,
          positionId,
          args.executionId,
          'OPEN',
          nextQty,
          nextCost,
          '0.0000',
        );
        return;
      }
      await client.query(
        `UPDATE positions
         SET status = 'OPEN', quantity = $2, average_entry = $3, cost_basis = $4,
             opened_at = COALESCE(opened_at, now()), closed_at = NULL, updated_at = now()
         WHERE id = $1`,
        [args.position.id, nextQty, args.fillPrice, nextCost],
      );
      await this.positionEvent(
        client,
        args.position.id,
        args.executionId,
        reopened ? 'REOPEN' : 'OPEN',
        nextQty,
        nextCost,
        '0.0000',
      );
      return;
    }
    if (!args.position) throw new Error('sell has no position');
    const nextQty = subtractDecimals(args.position.quantity, args.fillQty, scale);
    const costRemoved = decimalsEqual(args.fillQty, args.position.quantity, scale)
      ? args.position.cost_basis
      : multiplyDecimals(
          args.position.average_entry,
          args.fillQty,
          args.instrument.price_scale,
          scale,
          MONEY,
        );
    const nextCost = subtractDecimals(args.position.cost_basis, costRemoved, MONEY);
    const realized = subtractDecimals(args.notional, costRemoved, MONEY);
    const reserved = addDecimals(args.position.reserved_sell, args.sellReserved, scale);
    const closed =
      !decimalGreaterThan(nextQty, '0', scale) && !decimalGreaterThan(reserved, '0', scale);
    await client.query(
      `UPDATE positions
       SET status = $2, quantity = $3, reserved_sell = $4, cost_basis = $5,
           realized_pnl = realized_pnl + $6, closed_at = CASE WHEN $2 = 'CLOSED' THEN now() ELSE closed_at END,
           updated_at = now()
       WHERE id = $1`,
      [
        args.position.id,
        closed ? 'CLOSED' : 'OPEN',
        nextQty,
        reserved,
        decimalLessThan(nextCost, '0', MONEY) ? zero(MONEY) : nextCost,
        realized,
      ],
    );
    await this.positionEvent(
      client,
      args.position.id,
      args.executionId,
      closed ? 'CLOSE' : 'REDUCE',
      nextQty,
      decimalLessThan(nextCost, '0', MONEY) ? zero(MONEY) : nextCost,
      realized,
    );
  }

  private async persistReject(
    client: PoolClient,
    input: OrderInput,
    initialCapital: string,
    instrument: InstrumentRow | undefined,
    reason: string,
    decision?: RiskDecision,
    cash: string | null = null,
  ): Promise<TradingOrderResult> {
    if (!instrument) {
      const result: TradingOrderResult = {
        orderId: null,
        state: 'REJECTED',
        rejectReason: reason,
        filledQuantity: '0.00000000',
        cash,
        executionId: null,
      };
      await this.storeCommand(client, input, result);
      return result;
    }
    let quantity = '0';
    try {
      quantity = canonicalDecimal(input.quantity, instrument.quantity_scale);
    } catch (error) {
      if (!(error instanceof DecimalError)) throw error;
    }
    if (!decimalGreaterThan(quantity, '0', instrument.quantity_scale)) {
      quantity =
        instrument.quantity_scale === 0
          ? '1'
          : `0.${'0'.repeat(Math.max(instrument.quantity_scale - 1, 0))}1`;
    }
    const quote = input.quote;
    const order = await client.query<{ id: string }>(
      `INSERT INTO orders (
         account_id, user_id, instrument_id, client_order_id, side, order_type, state,
         quantity, filled_quantity, limit_price, cash_reserved, sell_reserved, reject_reason,
         risk_decision_id, quote_asset, price_origin, live_market_data, feed_state, received_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'REJECTED',
         $7, 0, $8, 0, 0, $9,
         $10, $11, $12, false, $13, $14
       ) RETURNING id`,
      [
        input.accountId,
        input.userId,
        input.instrumentId,
        input.clientOrderId,
        input.side,
        input.orderType,
        quantity,
        input.limitPrice,
        reason,
        decision?.decisionId ?? null,
        instrument.quote_asset ?? 'USD',
        quote?.priceOrigin ?? 'TEST_FIXTURE',
        quote?.feedState ?? 'DISCONNECTED',
        quote?.receivedAt ?? null,
      ],
    );
    const orderId = order.rows[0]?.id ?? null;
    if (orderId && decision) await this.recordDecision(client, decision, orderId, input.accountId);
    if (orderId)
      await this.recordTransition(client, orderId, null, 'REJECTED', reason, input.userId);
    const seeded = await this.lockCash(client, input.accountId, initialCapital);
    const result: TradingOrderResult = {
      orderId,
      state: 'REJECTED',
      rejectReason: reason,
      filledQuantity: zero(instrument.quantity_scale),
      cash: cash ?? seeded.cash,
      executionId: null,
    };
    await this.storeCommand(client, input, result);
    await this.event(client, input.accountId, 'order.rejected', result);
    return result;
  }

  private async lockPosition(
    client: PoolClient,
    accountId: string,
    instrumentId: string,
  ): Promise<PositionRow | null> {
    const result = await client.query<PositionRow>(
      `SELECT id, quantity::text, reserved_sell::text, status, cost_basis::text, average_entry::text
       FROM positions WHERE account_id = $1 AND instrument_id = $2 FOR UPDATE`,
      [accountId, instrumentId],
    );
    return result.rows[0] ?? null;
  }

  private async lockCash(
    client: PoolClient,
    accountId: string,
    initialCapital: string,
  ): Promise<{ cash: string; reserved: string }> {
    const capital = canonicalDecimal(initialCapital, MONEY);
    await client.query(
      `INSERT INTO simulation_cash_movements (movement_key, account_id, amount)
       VALUES ($1, $2, $3)
       ON CONFLICT (movement_key) DO NOTHING`,
      [`seed:${accountId}`, accountId, capital],
    );
    await client.query(
      `INSERT INTO simulation_cash_projections (account_id, cash)
       VALUES ($1, $2)
       ON CONFLICT (account_id) DO NOTHING`,
      [accountId, capital],
    );
    const row = await client.query<{ cash: string; reserved_cash: string }>(
      `SELECT cash::text, reserved_cash::text
       FROM simulation_cash_projections WHERE account_id = $1 FOR UPDATE`,
      [accountId],
    );
    const locked = row.rows[0];
    if (!locked) throw new Error('cash projection missing');
    return {
      cash: canonicalDecimal(locked.cash, MONEY),
      reserved: canonicalDecimal(locked.reserved_cash, MONEY),
    };
  }

  private async insertExecution(
    client: PoolClient,
    args: {
      orderId: string;
      input: OrderInput;
      instrumentId: string;
      fillQty: string;
      fillPrice: string;
      notional: string;
      fee: string;
      quote: ExecutableQuote;
      sequenceNo?: number;
    },
  ): Promise<string> {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO executions (
         order_id, account_id, instrument_id, sequence_no, quantity, price, notional, commission,
         quote_update_id, received_at, price_origin, live_market_data, execution_venue
       ) VALUES ($1, $2, $3, $11, $4, $5, $6, $7, $8, $9, $10, false, 'K2_SIMULATION')
       RETURNING id`,
      [
        args.orderId,
        args.input.accountId,
        args.instrumentId,
        args.fillQty,
        args.fillPrice,
        args.notional,
        args.fee,
        args.quote.quoteUpdateId,
        args.quote.receivedAt,
        args.quote.priceOrigin,
        args.sequenceNo ?? 1,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error('execution insert returned no id');
    return id;
  }

  private async outbox(
    client: PoolClient,
    accountId: string,
    executionId: string,
    notional: string,
    fee: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ledger_outbox (event_type, idempotency_key, account_id, execution_id, amount, currency)
       VALUES ('fill', $1, $2, $3, $4, 'USD')`,
      [`fill:${executionId}`, accountId, executionId, notional],
    );
    if (decimalGreaterThan(fee, '0', MONEY)) {
      await client.query(
        `INSERT INTO ledger_outbox (event_type, idempotency_key, account_id, execution_id, amount, currency)
         VALUES ('commission', $1, $2, $3, $4, 'USD')`,
        [`commission:${executionId}`, accountId, executionId, fee],
      );
    }
  }

  private async recordDecision(
    client: PoolClient,
    decision: RiskDecision,
    orderId: string,
    accountId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO risk_authorization_log (decision_id, order_id, account_id, mode, decision, reason_code)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        decision.decisionId,
        orderId,
        accountId,
        decision.mode,
        decision.decision,
        decision.reasonCode,
      ],
    );
  }

  private async recordTransition(
    client: PoolClient,
    orderId: string,
    from: string | null,
    to: string,
    reason: string,
    userId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO order_state_transitions (order_id, from_state, to_state, reason, actor_user_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orderId, from, to, reason, userId, `${orderId}:${to}:${reason}`],
    );
  }

  private async positionEvent(
    client: PoolClient,
    positionId: string,
    executionId: string,
    eventType: string,
    quantityAfter: string,
    costAfter: string,
    realized: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO position_events (
         position_id, execution_id, event_type, quantity_after, cost_basis_after, realized_delta
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [positionId, executionId, eventType, quantityAfter, costAfter, realized],
    );
  }

  private async event(
    client: PoolClient,
    accountId: string,
    eventType: string,
    payload: TradingOrderResult,
  ): Promise<void> {
    const sequence = await client.query<{ last_sequence: string }>(
      `INSERT INTO trading_event_counters (account_id, last_sequence)
       VALUES ($1, 1)
       ON CONFLICT (account_id) DO UPDATE
         SET last_sequence = trading_event_counters.last_sequence + 1
       RETURNING last_sequence::text`,
      [accountId],
    );
    await client.query(
      `INSERT INTO trading_events (account_id, sequence_no, event_type, payload)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [accountId, sequence.rows[0]?.last_sequence ?? '1', eventType, JSON.stringify(payload)],
    );
  }

  private async storeCommand(
    client: PoolClient,
    input: OrderInput,
    result: TradingOrderResult,
  ): Promise<void> {
    await client.query(
      `INSERT INTO trading_commands (idempotency_key, command_name, user_id, request_hash, response)
       VALUES ($1, 'orders.submit', $2, $3, $4::jsonb)`,
      [input.idempotencyKey, input.userId, requestHash(input), JSON.stringify(result)],
    );
  }

  private async readCommand(key: string, client?: PoolClient): Promise<StoredCommand | null> {
    const queryable = client ?? this.pool;
    const result = await queryable.query<StoredCommand>(
      `SELECT user_id, request_hash, response FROM trading_commands WHERE idempotency_key = $1`,
      [key],
    );
    return result.rows[0] ?? null;
  }

  private tradingOpen(): boolean {
    return this.lock === null || this.lock.fillsAllowed();
  }

  private async drainQueue(instrumentId: string, quote: ExecutableQuote): Promise<string[]> {
    const waiting = await this.pool.query<{ id: string }>(
      `SELECT id FROM orders
       WHERE instrument_id = $1 AND state IN ('OPEN', 'PARTIALLY_FILLED')
       ORDER BY accept_sequence`,
      [instrumentId],
    );
    const filled: string[] = [];
    for (const row of waiting.rows) {
      if (!this.tradingOpen()) break;
      const did = await this.transaction((client) => this.fillWorking(client, row.id, quote));
      if (did) filled.push(row.id);
    }
    return filled;
  }

  private async fillWorking(
    client: PoolClient,
    orderId: string,
    quote: ExecutableQuote,
  ): Promise<boolean> {
    if (!this.tradingOpen() || !this.fillsEnabled) return false;
    const peek = await client.query<{ account_id: string }>(
      'SELECT account_id FROM orders WHERE id = $1',
      [orderId],
    );
    const accountId = peek.rows[0]?.account_id;
    if (!accountId) return false;
    const account = await client.query<{ initial_capital: string; state: string }>(
      `SELECT initial_capital::text, state FROM trading_accounts WHERE id = $1 FOR UPDATE`,
      [accountId],
    );
    const locked = account.rows[0];
    if (!locked || locked.state !== 'ACTIVE') return false;
    const orderResult = await client.query<{
      user_id: string;
      instrument_id: string;
      client_order_id: string;
      side: 'BUY' | 'SELL';
      order_type: 'MARKET' | 'LIMIT';
      state: string;
      quantity: string;
      filled_quantity: string;
      limit_price: string | null;
      cash_reserved: string;
      sell_reserved: string;
    }>(
      `SELECT user_id, instrument_id, client_order_id, side, order_type, state,
              quantity::text, filled_quantity::text, limit_price::text,
              cash_reserved::text, sell_reserved::text
       FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    const order = orderResult.rows[0];
    if (!order || (order.state !== 'OPEN' && order.state !== 'PARTIALLY_FILLED')) return false;
    const instrumentResult = await client.query<InstrumentRow>(
      `SELECT market, quote_asset, trading_status, price_scale, quantity_scale
       FROM instruments WHERE id = $1`,
      [order.instrument_id],
    );
    const instrument = instrumentResult.rows[0];
    if (!instrument) return false;
    const priceScale = instrument.price_scale;
    const qtyScale = instrument.quantity_scale;
    const asset = instrument.quote_asset;
    const bid =
      asset && settlesAsUsd(asset)
        ? quotePriceToUsd(asset, quote.bid, priceScale)
        : canonicalDecimal(quote.bid, priceScale);
    const ask =
      asset && settlesAsUsd(asset)
        ? quotePriceToUsd(asset, quote.ask, priceScale)
        : canonicalDecimal(quote.ask, priceScale);
    const touch = order.side === 'BUY' ? ask : bid;
    const limit = order.limit_price ? canonicalDecimal(order.limit_price, priceScale) : null;
    const marketable =
      order.order_type === 'MARKET' ||
      (order.side === 'BUY'
        ? !decimalLessThan(limit ?? touch, touch, priceScale)
        : !decimalGreaterThan(limit ?? touch, touch, priceScale));
    if (!marketable) return false;
    const already = await client.query(
      'SELECT 1 FROM executions WHERE order_id = $1 AND quote_update_id = $2',
      [orderId, quote.quoteUpdateId],
    );
    if ((already.rowCount ?? 0) > 0) return false;
    const remaining = subtractDecimals(order.quantity, order.filled_quantity, qtyScale);
    if (!decimalGreaterThan(remaining, '0', qtyScale)) return false;
    const displayed = canonicalDecimal(
      order.side === 'BUY' ? quote.askSize : quote.bidSize,
      qtyScale,
    );
    const deferred = await client.query(
      `SELECT 1 FROM deferred_closes WHERE order_id = $1 AND state = 'AWAITING_FRESH'`,
      [orderId],
    );
    const awaitingFresh = (deferred.rowCount ?? 0) > 0;
    if (awaitingFresh && quote.feedState !== 'LIVE') return false;
    const taken = awaitingFresh
      ? null
      : await takeLiquidity(client, {
          instrumentId: order.instrument_id,
          source: liquiditySource(quote.priceOrigin),
          bookSide: order.side === 'BUY' ? 'ASK' : 'BID',
          price: touch,
          priceScale,
          quoteUpdateId: quote.quoteUpdateId,
          displayed,
          want: remaining,
          quantityScale: qtyScale,
        });
    if (!awaitingFresh && !decimalGreaterThan(taken?.quantity ?? '0', '0', qtyScale)) return false;
    const fillQty = awaitingFresh ? remaining : (taken?.quantity ?? zero(qtyScale));
    const unfilled = subtractDecimals(remaining, fillQty, qtyScale);
    const remainderRests =
      order.order_type === 'LIMIT' && decimalGreaterThan(unfilled, '0', qtyScale);
    const nextFilled = addDecimals(order.filled_quantity, fillQty, qtyScale);
    const state = decimalsEqual(nextFilled, order.quantity, qtyScale)
      ? 'FILLED'
      : remainderRests
        ? 'PARTIALLY_FILLED'
        : 'CANCELLED';
    const filledNotional = multiplyDecimals(touch, fillQty, priceScale, qtyScale, MONEY);
    const filledFee = order.side === 'BUY' ? openingFee(filledNotional) : zero(MONEY);
    const reservePrice = order.order_type === 'LIMIT' && limit ? limit : touch;
    const newReserve =
      order.side === 'BUY' && remainderRests
        ? this.cashNeed('BUY', unfilled, reservePrice, priceScale, qtyScale)
        : zero(MONEY);
    const newSellReserved =
      order.side === 'SELL' && state === 'PARTIALLY_FILLED' ? unfilled : zero(qtyScale);
    const cash = await this.lockCash(client, accountId, locked.initial_capital);
    const spent = addDecimals(filledNotional, filledFee, MONEY);
    const nextCash =
      order.side === 'BUY'
        ? subtractDecimals(cash.cash, spent, MONEY)
        : addDecimals(cash.cash, filledNotional, MONEY);
    const released =
      order.side === 'BUY' ? canonicalDecimal(order.cash_reserved, MONEY) : zero(MONEY);
    const nextReserved = addDecimals(
      subtractDecimals(cash.reserved, released, MONEY),
      newReserve,
      MONEY,
    );
    if (decimalLessThan(nextCash, '0', MONEY) || decimalLessThan(nextCash, nextReserved, MONEY)) {
      throw new Error('resting fill would break the cash projection');
    }
    await client.query(
      `UPDATE orders
       SET state = $2, filled_quantity = $3, cash_reserved = $4, sell_reserved = $5,
           updated_at = now(), version = version + 1
       WHERE id = $1`,
      [orderId, state, nextFilled, newReserve, newSellReserved],
    );
    await this.recordTransition(
      client,
      orderId,
      order.state,
      state,
      `quote:${quote.quoteUpdateId}`,
      order.user_id,
    );
    const sequence = await client.query<{ next: number }>(
      'SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next FROM executions WHERE order_id = $1',
      [orderId],
    );
    const input: OrderInput = {
      accountId,
      userId: order.user_id,
      instrumentId: order.instrument_id,
      clientOrderId: order.client_order_id,
      idempotencyKey: `quote:${orderId}:${quote.quoteUpdateId}`,
      side: order.side,
      orderType: order.order_type,
      quantity: order.quantity,
      limitPrice: order.limit_price,
      quote,
    };
    const executionId = await this.insertExecution(client, {
      orderId,
      input,
      instrumentId: order.instrument_id,
      fillQty,
      fillPrice: touch,
      notional: filledNotional,
      fee: filledFee,
      quote,
      sequenceNo: sequence.rows[0]?.next ?? 1,
    });
    const position = await this.lockPosition(client, accountId, order.instrument_id);
    if (order.side === 'BUY') {
      await this.applyPosition(client, {
        input,
        instrument,
        position,
        fillQty,
        fillPrice: touch,
        notional: filledNotional,
        executionId,
        sellReserved: zero(qtyScale),
      });
    } else if (position) {
      const nextQty = subtractDecimals(position.quantity, fillQty, qtyScale);
      const reduced = subtractDecimals(position.reserved_sell, fillQty, qtyScale);
      const reservedSell = decimalLessThan(reduced, '0', qtyScale) ? zero(qtyScale) : reduced;
      const closed =
        !decimalGreaterThan(nextQty, '0', qtyScale) &&
        !decimalGreaterThan(reservedSell, '0', qtyScale);
      await client.query(
        `UPDATE positions
         SET status = $2, quantity = $3, reserved_sell = $4, updated_at = now(),
             closed_at = CASE WHEN $2 = 'CLOSED' THEN now() ELSE closed_at END
         WHERE id = $1`,
        [position.id, closed ? 'CLOSED' : 'OPEN', nextQty, reservedSell],
      );
    }
    await this.outbox(client, accountId, executionId, filledNotional, filledFee);
    if (taken) {
      await client.query(
        `INSERT INTO liquidity_allocations (
           execution_id, instrument_id, book_side, price, displayed_qty, consumed_before,
           take_qty, consumed_after, accept_sequence, quote_update_id
         )
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, accept_sequence, $9
         FROM orders WHERE id = $10`,
        [
          executionId,
          order.instrument_id,
          taken.bookSide,
          taken.price,
          taken.displayed,
          taken.consumedBefore,
          taken.quantity,
          taken.consumedAfter,
          taken.quoteUpdateId,
          orderId,
        ],
      );
    }
    if (awaitingFresh) {
      await client.query(`UPDATE deferred_closes SET state = 'FILLED' WHERE order_id = $1`, [
        orderId,
      ]);
      await client.query(
        `UPDATE risk_reducing_audits
            SET quote_age_fill_ms = $2
          WHERE order_id = $1 AND price_basis = 'DEFERRED_FRESH'`,
        [orderId, quoteAgeMs(quote)],
      );
    }
    await client.query(
      `UPDATE simulation_cash_projections
       SET cash = $2, reserved_cash = $3, event_sequence = event_sequence + 1, updated_at = now()
       WHERE account_id = $1`,
      [accountId, nextCash, nextReserved],
    );
    if (!decimalsEqual(nextCash, cash.cash, MONEY)) {
      await client.query(
        `INSERT INTO simulation_cash_movements (movement_key, account_id, amount)
         VALUES ($1, $2, $3)`,
        [
          `cash:${orderId}:${quote.quoteUpdateId}`,
          accountId,
          subtractDecimals(nextCash, cash.cash, MONEY),
        ],
      );
    }
    return true;
  }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function cryptoOrEquitySettlement(market: string, quoteAsset: string | null): boolean {
  if (!settlesAsUsd(quoteAsset)) return false;
  if (market === 'CRYPTO') return quoteAsset === 'USDT';
  if (market === 'EQUITIES') return quoteAsset === 'USD';
  return false;
}

function openingFee(notional: string): string {
  const scaled = multiplyDecimals(notional, OPENING_COMMISSION_PCT, MONEY, MONEY, MONEY);
  return divideByInt(scaled, MONEY, 100n, MONEY);
}

function zero(scale: number): string {
  return canonicalDecimal('0', scale);
}

function requestHash(input: OrderInput): string {
  const body = JSON.stringify({
    accountId: input.accountId,
    clientOrderId: input.clientOrderId,
    instrumentId: input.instrumentId,
    limitPrice: input.limitPrice,
    orderType: input.orderType,
    quantity: input.quantity,
    side: input.side,
  });
  return createHash('sha256').update(body).digest('hex');
}

function quoteAgeMs(quote: ExecutableQuote): number {
  const age = Date.now() - quote.receivedAt.getTime();
  return age > 0 ? Math.trunc(age) : 0;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === constraint
  );
}
