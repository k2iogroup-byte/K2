import { createHash } from 'node:crypto';

import { canonicalDecimal, decimalGreaterThan, decimalLessThan } from '@k2/shared';
import type { Pool, PoolClient } from 'pg';

import { attachInstrumentProtection, fireProtection } from './protection.js';
import { advanceTriggerCursor, triggerQuoteIsNew } from './quote-cursor.js';
import type { TradingLock } from './singleton.js';
import type { TradingFanout } from './trading-fanout.js';
import type { ExecutableQuote, TradingOrderResult, TradingService } from './trading-service.js';
import { TradingConflictError, TradingNotFoundError } from './trading-service.js';

/** One table of allowed side and purpose pairs. SELL STOP is absent on purpose. */
export const ALLOWED_ORDER_ACTIONS = [
  { side: 'BUY', purpose: 'MARKET' },
  { side: 'BUY', purpose: 'LIMIT' },
  { side: 'BUY', purpose: 'STOP' },
  { side: 'SELL', purpose: 'MARKET' },
  { side: 'SELL', purpose: 'LIMIT' },
  { side: 'SELL', purpose: 'CLOSE' },
] as const;

export function orderActionAllowed(side: string, purpose: string): boolean {
  return ALLOWED_ORDER_ACTIONS.some((row) => row.side === side && row.purpose === purpose);
}

type StopInput = {
  accountId: string;
  userId: string;
  instrumentId: string;
  clientOrderId: string;
  idempotencyKey: string;
  quantity: string;
  triggerPrice: string;
  quote: ExecutableQuote | null;
};

export class Phase2Orders {
  constructor(
    private readonly pool: Pool,
    private readonly trading: TradingService,
    private readonly lock: TradingLock | null = null,
    private readonly fillsEnabled = false,
    private readonly fanout: TradingFanout | null = null,
  ) {}

  private readonly latestQuote = new Map<string, ExecutableQuote>();
  private readonly quoteInflight = new Map<string, Promise<void>>();

  async placeStop(input: StopInput): Promise<TradingOrderResult> {
    if (!orderActionAllowed('BUY', 'STOP')) {
      return rejected('STOP_NOT_ALLOWED');
    }
    const hash = requestHash(input);
    const existing = await this.readCommand(input.idempotencyKey);
    if (existing) return this.replay(existing, input.userId, hash);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const account = await client.query(
        `SELECT id FROM trading_accounts WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [input.accountId, input.userId],
      );
      if ((account.rowCount ?? 0) === 0) throw new TradingNotFoundError();
      await client.query(
        `SELECT id FROM positions WHERE account_id = $1 AND instrument_id = $2 FOR UPDATE`,
        [input.accountId, input.instrumentId],
      );
      const blocked = await entryBlocked(client, input.accountId, input.instrumentId);
      if (blocked) {
        const result = rejected('POSITION_ALREADY_OPEN');
        await storeCommand(client, input.idempotencyKey, input.userId, hash, result);
        await client.query('COMMIT');
        return result;
      }
      const instrument = await client.query<{ price_scale: number; quantity_scale: number }>(
        'SELECT price_scale, quantity_scale FROM instruments WHERE id = $1',
        [input.instrumentId],
      );
      const scales = instrument.rows[0];
      if (!scales) {
        const result = rejected('INSTRUMENT_NOT_TRADABLE');
        await storeCommand(client, input.idempotencyKey, input.userId, hash, result);
        await client.query('COMMIT');
        return result;
      }
      const trigger = canonicalDecimal(input.triggerPrice, scales.price_scale);
      const quantity = canonicalDecimal(input.quantity, scales.quantity_scale);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO conditional_orders (
           account_id, user_id, instrument_id, kind, side, trigger_price, quantity, state,
           idempotency_key, client_order_id
         ) VALUES ($1, $2, $3, 'ENTRY_STOP', 'BUY', $4, $5, 'PENDING', $6, $7)
         RETURNING id`,
        [
          input.accountId,
          input.userId,
          input.instrumentId,
          trigger,
          quantity,
          input.idempotencyKey,
          input.clientOrderId,
        ],
      );
      const result: TradingOrderResult = {
        orderId: inserted.rows[0]?.id ?? null,
        state: 'PENDING',
        rejectReason: null,
        filledQuantity: '0.00000000',
        cash: null,
        executionId: null,
      };
      await storeCommand(client, input.idempotencyKey, input.userId, hash, result);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if (isPositionConflict(error)) return rejected('POSITION_ALREADY_OPEN');
      throw error;
    } finally {
      client.release();
    }
  }

  async nativeBuyBlocked(
    accountId: string,
    userId: string,
    instrumentId: string,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const account = await client.query(
        `SELECT id FROM trading_accounts WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [accountId, userId],
      );
      if ((account.rowCount ?? 0) === 0) throw new TradingNotFoundError();
      await client.query(
        `SELECT id FROM positions WHERE account_id = $1 AND instrument_id = $2 FOR UPDATE`,
        [accountId, instrumentId],
      );
      const blocked = await entryBlocked(client, accountId, instrumentId);
      await client.query('COMMIT');
      return blocked;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * One quote path for resting orders, entry stops, and protection.
   * At most one evaluation runs per instrument. A newer quote replaces any
   * quote that is still waiting.
   */
  async onQuote(instrumentId: string, quote: ExecutableQuote): Promise<void> {
    this.latestQuote.set(instrumentId, quote);
    for (;;) {
      const running = this.quoteInflight.get(instrumentId);
      if (running) {
        await running;
        if (this.latestQuote.has(instrumentId)) continue;
        return;
      }
      if (!this.latestQuote.has(instrumentId)) return;
      const task = this.drainQuotes(instrumentId);
      this.quoteInflight.set(instrumentId, task);
      try {
        await task;
      } finally {
        if (this.quoteInflight.get(instrumentId) === task) {
          this.quoteInflight.delete(instrumentId);
        }
      }
    }
  }

  /** After the lock is acquired, walk the latest stored snapshot once. */
  async evaluateSnapshots(): Promise<void> {
    if (this.lock && !this.lock.fillsAllowed()) return;
    const rows = await this.pool
      .query<{
        instrument_id: string;
        bid: string;
        ask: string;
        bid_size: string;
        ask_size: string;
        received_timestamp: Date;
        feed_state: ExecutableQuote['feedState'];
        price_origin: ExecutableQuote['priceOrigin'];
        provider_event_id: string;
        sequence_no: string;
      }>(
        `SELECT instrument_id, bid::text, ask::text, bid_size::text, ask_size::text,
                received_timestamp, feed_state, price_origin, provider_event_id, sequence_no::text
           FROM quote_snapshots`,
      )
      .catch((error: unknown) => {
        if (isMissingRelation(error)) return { rows: [] };
        throw error;
      });
    for (const row of rows.rows) {
      const updateId = /^[0-9]+$/.test(row.provider_event_id)
        ? row.provider_event_id
        : row.sequence_no;
      await this.onQuote(row.instrument_id, {
        quoteUpdateId: updateId,
        bid: row.bid,
        ask: row.ask,
        bidSize: row.bid_size,
        askSize: row.ask_size,
        receivedAt: row.received_timestamp,
        feedState: row.feed_state,
        priceOrigin: row.price_origin,
      });
    }
  }

  private async drainQuotes(instrumentId: string): Promise<void> {
    while (this.latestQuote.has(instrumentId)) {
      const quote = this.latestQuote.get(instrumentId);
      this.latestQuote.delete(instrumentId);
      if (!quote) return;
      await this.evaluateQuote(instrumentId, quote);
    }
  }

  private async evaluateQuote(instrumentId: string, quote: ExecutableQuote): Promise<void> {
    if (this.lock && !this.lock.fillsAllowed()) return;
    if (!this.fillsEnabled) {
      await this.trading.applyQuote(instrumentId, quote);
      return;
    }
    if (!(await triggerQuoteIsNew(this.pool, instrumentId, quote))) return;
    await this.trading.applyQuote(instrumentId, quote);
    await this.fireEntryStops(instrumentId, quote);
    await attachInstrumentProtection(this.pool, instrumentId);
    await fireProtection(this.pool, this.trading, instrumentId, quote, this.fanout);
    await this.publishFills(instrumentId, quote.quoteUpdateId);
    await this.markQuoteProcessed(instrumentId, quote);
  }

  private async markQuoteProcessed(instrumentId: string, quote: ExecutableQuote): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await advanceTriggerCursor(client, instrumentId, quote);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async publishFills(instrumentId: string, quoteUpdateId: string): Promise<void> {
    if (!this.fanout) return;
    const fills = await this.pool.query<{
      user_id: string;
      account_id: string;
      quantity: string;
      price: string;
    }>(
      `SELECT orders.user_id, orders.account_id, executions.quantity::text, executions.price::text
         FROM executions
         JOIN orders ON orders.id = executions.order_id
        WHERE executions.instrument_id = $1 AND executions.quote_update_id = $2`,
      [instrumentId, quoteUpdateId],
    );
    const accounts = new Set<string>();
    for (const fill of fills.rows) {
      this.fanout.publish(fill.user_id, {
        type: 'fill',
        accountId: fill.account_id,
      });
      accounts.add(`${fill.user_id}:${fill.account_id}`);
    }
    for (const pair of accounts) {
      const split = pair.split(':');
      const userId = split[0] ?? '';
      const accountId = split[1] ?? '';
      this.fanout.publish(userId, { type: 'position', accountId });
    }
  }

  async readOrder(userId: string, orderId: string): Promise<TradingOrderResult | null> {
    const order = await this.pool.query<{
      state: string;
      filled_quantity: string;
      reject_reason: string | null;
    }>(
      `SELECT state, filled_quantity::text, reject_reason
       FROM orders WHERE id = $1 AND user_id = $2`,
      [orderId, userId],
    );
    const row = order.rows[0];
    if (row) {
      return {
        orderId,
        state: row.state,
        rejectReason: row.reject_reason,
        filledQuantity: row.filled_quantity,
        cash: null,
        executionId: null,
      };
    }
    const foreign = await this.pool.query('SELECT 1 FROM orders WHERE id = $1', [orderId]);
    if ((foreign.rowCount ?? 0) > 0) return null;
    const conditional = await this.pool.query<{
      state: string;
      user_id: string;
      resulting_order_id: string | null;
    }>(`SELECT state, user_id, resulting_order_id FROM conditional_orders WHERE id = $1`, [
      orderId,
    ]);
    const pending = conditional.rows[0];
    if (!pending || pending.user_id !== userId) return null;
    if (pending.resulting_order_id) {
      return this.readOrder(userId, pending.resulting_order_id);
    }
    return {
      orderId,
      state: pending.state,
      rejectReason: null,
      filledQuantity: '0.00000000',
      cash: null,
      executionId: null,
    };
  }

  private async fireEntryStops(instrumentId: string, quote: ExecutableQuote): Promise<void> {
    const pending = await this.pool.query<{ id: string }>(
      `SELECT id FROM conditional_orders
       WHERE instrument_id = $1 AND kind = 'ENTRY_STOP' AND state = 'PENDING'
       ORDER BY created_at, id`,
      [instrumentId],
    );
    for (const row of pending.rows) {
      await this.fireOneStop(row.id, quote);
    }
  }

  private async fireOneStop(id: string, quote: ExecutableQuote): Promise<void> {
    const claimed = await this.claimStop(id, quote);
    if (!claimed) return;
    const result = await this.trading.submit({
      accountId: claimed.account_id,
      userId: claimed.user_id,
      instrumentId: claimed.instrument_id,
      clientOrderId: `stop-${id}`,
      idempotencyKey: `trigger:${id}:${quote.quoteUpdateId}`,
      side: 'BUY',
      orderType: 'MARKET',
      quantity: claimed.quantity,
      limitPrice: null,
      quote,
    });
    await this.pool.query(
      `UPDATE conditional_orders SET resulting_order_id = $2, updated_at = now() WHERE id = $1`,
      [id, result.orderId],
    );
  }

  private async claimStop(
    id: string,
    quote: ExecutableQuote,
  ): Promise<{
    account_id: string;
    user_id: string;
    instrument_id: string;
    quantity: string;
  } | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<{
        account_id: string;
        user_id: string;
        instrument_id: string;
        quantity: string;
        trigger_price: string;
        state: string;
        price_scale: number;
        version: string;
      }>(
        `SELECT conditional_orders.account_id, conditional_orders.user_id,
                conditional_orders.instrument_id, conditional_orders.quantity::text,
                conditional_orders.trigger_price::text, conditional_orders.state,
                conditional_orders.version::text,
                instruments.price_scale
         FROM conditional_orders
         JOIN instruments ON instruments.id = conditional_orders.instrument_id
         WHERE conditional_orders.id = $1
         FOR UPDATE OF conditional_orders`,
        [id],
      );
      const row = locked.rows[0];
      if (!row || row.state !== 'PENDING') {
        await client.query('COMMIT');
        return null;
      }
      await client.query('SELECT id FROM trading_accounts WHERE id = $1 FOR UPDATE', [
        row.account_id,
      ]);
      const trigger = canonicalDecimal(row.trigger_price, row.price_scale);
      const ask = canonicalDecimal(quote.ask, row.price_scale);
      if (decimalLessThan(ask, trigger, row.price_scale)) {
        await client.query('COMMIT');
        return null;
      }
      const triggered = await client.query(
        `UPDATE conditional_orders
            SET state = 'TRIGGERED', updated_at = now(), version = version + 1
          WHERE id = $1 AND state = 'PENDING' AND version = $2`,
        [id, row.version],
      );
      if ((triggered.rowCount ?? 0) === 0) {
        await client.query('COMMIT');
        return null;
      }
      await advanceTriggerCursor(client, row.instrument_id, quote);
      await client.query('COMMIT');
      return row;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async readCommand(
    key: string,
  ): Promise<{ user_id: string; request_hash: string; response: TradingOrderResult } | null> {
    const result = await this.pool.query<{
      user_id: string;
      request_hash: string;
      response: TradingOrderResult;
    }>('SELECT user_id, request_hash, response FROM trading_commands WHERE idempotency_key = $1', [
      key,
    ]);
    return result.rows[0] ?? null;
  }

  private replay(
    existing: { user_id: string; request_hash: string; response: TradingOrderResult },
    userId: string,
    hash: string,
  ): TradingOrderResult {
    if (existing.user_id !== userId || existing.request_hash !== hash)
      throw new TradingConflictError();
    return existing.response;
  }
}

function rejected(reason: string): TradingOrderResult {
  return {
    orderId: null,
    state: 'REJECTED',
    rejectReason: reason,
    filledQuantity: '0.00000000',
    cash: null,
    executionId: null,
  };
}

async function entryBlocked(
  client: PoolClient,
  accountId: string,
  instrumentId: string,
): Promise<boolean> {
  const position = await client.query<{ quantity: string; reserved_sell: string }>(
    `SELECT quantity::text, reserved_sell::text FROM positions
     WHERE account_id = $1 AND instrument_id = $2`,
    [accountId, instrumentId],
  );
  const row = position.rows[0];
  if (
    row &&
    (decimalGreaterThan(row.quantity, '0', 8) || decimalGreaterThan(row.reserved_sell, '0', 8))
  ) {
    return true;
  }
  const working = await client.query(
    `SELECT 1 FROM orders
     WHERE account_id = $1 AND instrument_id = $2
       AND state IN ('OPEN', 'PARTIALLY_FILLED')
     LIMIT 1`,
    [accountId, instrumentId],
  );
  if ((working.rowCount ?? 0) > 0) return true;
  const pending = await client.query(
    `SELECT 1 FROM conditional_orders
     WHERE account_id = $1 AND instrument_id = $2 AND kind = 'ENTRY_STOP' AND state = 'PENDING'
     LIMIT 1`,
    [accountId, instrumentId],
  );
  return (pending.rowCount ?? 0) > 0;
}

async function storeCommand(
  client: PoolClient,
  key: string,
  userId: string,
  hash: string,
  response: TradingOrderResult,
): Promise<void> {
  await client.query(
    `INSERT INTO trading_commands (idempotency_key, command_name, user_id, request_hash, response)
     VALUES ($1, 'orders.stop', $2, $3, $4::jsonb)`,
    [key, userId, hash, JSON.stringify(response)],
  );
}

function isMissingRelation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '42P01';
}

function requestHash(input: StopInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        accountId: input.accountId,
        clientOrderId: input.clientOrderId,
        instrumentId: input.instrumentId,
        quantity: input.quantity,
        triggerPrice: input.triggerPrice,
      }),
    )
    .digest('hex');
}

function isPositionConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === '23505' || error.code === '23514')
  );
}
