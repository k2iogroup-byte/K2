import { createHash } from 'node:crypto';

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

import {
  ClosedEquityCalendar,
  FailClosedRiskAuthorizer,
  type RiskAuthorizer,
  type RiskDecision,
  type SessionCalendar,
} from './risk-authorizer.js';

const MONEY = 4;
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
};

export class TradingService {
  private readonly authorizer: RiskAuthorizer;
  private readonly calendar: SessionCalendar;
  private readonly fillsEnabled: boolean;

  constructor(
    private readonly pool: Pool,
    options: TradingServiceOptions = {},
  ) {
    this.authorizer = options.authorizer ?? new FailClosedRiskAuthorizer();
    this.calendar = options.calendar ?? new ClosedEquityCalendar();
    this.fillsEnabled = options.fillsEnabled ?? false;
  }

  async submit(input: OrderInput): Promise<TradingOrderResult> {
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

    const reject = this.precheck(input, locked.state, instrument);
    if (reject)
      return this.persistReject(client, input, locked.initial_capital, instrument, reject);

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

  private precheck(input: OrderInput, state: string, instrument: InstrumentRow): string | null {
    if (state !== 'ACTIVE') return 'ACCOUNT_NOT_TRADABLE';
    if (instrument.market === 'CRYPTO' || instrument.quote_asset !== 'USD') {
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
    try {
      canonicalDecimal(input.quantity, instrument.quantity_scale);
      canonicalDecimal(quote.bid, instrument.price_scale);
      canonicalDecimal(quote.ask, instrument.price_scale);
      canonicalDecimal(quote.bidSize, instrument.quantity_scale);
      canonicalDecimal(quote.askSize, instrument.quantity_scale);
      if (input.orderType === 'LIMIT') {
        if (!input.limitPrice) return 'INVALID_ORDER';
        canonicalDecimal(input.limitPrice, instrument.price_scale);
      }
    } catch (error) {
      if (error instanceof DecimalError) return 'INVALID_ORDER';
      throw error;
    }
    if (
      !decimalGreaterThan(input.quantity, '0', instrument.quantity_scale) ||
      !decimalGreaterThan(quote.bid, '0', instrument.price_scale) ||
      !decimalGreaterThan(quote.ask, '0', instrument.price_scale) ||
      decimalLessThan(quote.ask, quote.bid, instrument.price_scale)
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
  ): Promise<TradingOrderResult> {
    const quote = input.quote;
    if (!quote)
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
    const quantity = canonicalDecimal(input.quantity, qtyScale);
    const touch = canonicalDecimal(input.side === 'BUY' ? quote.ask : quote.bid, priceScale);
    const displayed = canonicalDecimal(
      input.side === 'BUY' ? quote.askSize : quote.bidSize,
      qtyScale,
    );
    const limit = input.limitPrice ? canonicalDecimal(input.limitPrice, priceScale) : null;
    const marketable =
      input.orderType === 'MARKET' ||
      (input.side === 'BUY'
        ? !decimalLessThan(limit ?? touch, touch, priceScale)
        : !decimalGreaterThan(limit ?? touch, touch, priceScale));
    const fillQty = marketable ? minDecimal(quantity, displayed, qtyScale) : zero(qtyScale);
    if (input.orderType === 'MARKET' && !decimalGreaterThan(fillQty, '0', qtyScale)) {
      return this.persistReject(
        client,
        input,
        initialCapital,
        instrument,
        'NO_LIQUIDITY',
        decision,
      );
    }
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
    },
  ): Promise<string> {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO executions (
         order_id, account_id, instrument_id, sequence_no, quantity, price, notional, commission,
         quote_update_id, received_at, price_origin, live_market_data, execution_venue
       ) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, false, 'K2_SIMULATION')
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

function openingFee(notional: string): string {
  const scaled = multiplyDecimals(notional, OPENING_COMMISSION_PCT, MONEY, MONEY, MONEY);
  return divideByInt(scaled, MONEY, 100n, MONEY);
}

function minDecimal(left: string, right: string, scale: number): string {
  return decimalLessThan(left, right, scale)
    ? canonicalDecimal(left, scale)
    : canonicalDecimal(right, scale);
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
