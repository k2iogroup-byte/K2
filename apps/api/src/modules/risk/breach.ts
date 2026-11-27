import { randomUUID } from 'node:crypto';

import { decimalGreaterThan, subtractDecimals } from '@k2/shared';
import type { Pool, PoolClient } from 'pg';

import type {
  ExecutableQuote,
  OrderInput,
  TradingOrderResult,
} from '../trading/trading-service.js';
import { readAccountEquity, rememberEquityHigh } from './engine.js';
import { dailyLossFloor, drawdownFloor, stressedBreaches } from './limits.js';
import { evaluateProgress } from './stage.js';

const MONEY = 4;

export interface RiskCloser {
  forceClose(client: PoolClient, input: OrderInput): Promise<TradingOrderResult>;
}

/**
 * Mark-to-market accounts touched by a quote. A breach force-closes free
 * quantity once. A second quote for the same account does not sell again.
 */
export async function evaluateInstrumentBreach(
  pool: Pool,
  trading: RiskCloser,
  instrumentId: string,
  quote: ExecutableQuote,
): Promise<void> {
  const accounts = await pool.query<{ account_id: string }>(
    `SELECT account_id FROM positions
     WHERE instrument_id = $1 AND status = 'OPEN' AND quantity > 0
     UNION
     SELECT account_id FROM executions
     WHERE instrument_id = $1 AND quote_update_id = $2`,
    [instrumentId, quote.quoteUpdateId],
  );
  for (const row of accounts.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const overlay = { instrumentId, bid: quote.bid, quote };
      await settleAccount(client, trading, row.account_id, overlay);
      await evaluateProgress(client, trading, row.account_id, new Date(), overlay);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Quote retries stay. The lock holder also retries unresolved closes once a minute. */
export async function retryForcedCloses(pool: Pool, trading: RiskCloser): Promise<void> {
  const rows = await pool.query<{ account_id: string }>(
    `SELECT DISTINCT breaches.account_id
     FROM risk_close_attempts AS attempts
     JOIN risk_breaches AS breaches ON breaches.id = attempts.breach_id
     WHERE NOT EXISTS (
       SELECT 1 FROM risk_close_resolutions AS resolutions
       WHERE resolutions.attempt_id = attempts.id
     )`,
  );
  for (const row of rows.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await settleAccount(client, trading, row.account_id);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function settleAccount(
  client: PoolClient,
  trading: RiskCloser,
  accountId: string,
  overlay?: { instrumentId: string; bid: string; quote?: ExecutableQuote },
): Promise<void> {
  const account = await client.query<{ state: string; initial_capital: string; user_id: string }>(
    `SELECT state, initial_capital::text, user_id
     FROM trading_accounts WHERE id = $1 FOR UPDATE`,
    [accountId],
  );
  const locked = account.rows[0];
  if (!locked || (locked.state !== 'ACTIVE' && locked.state !== 'FAILED')) return;

  let breachId = await existingBreach(client, accountId);
  if (locked.state === 'ACTIVE') {
    const equity = await readAccountEquity(client, accountId, overlay);
    if (!equity) return;
    const high = await rememberEquityHigh(client, accountId, equity);
    const daily = dailyLossFloor(high);
    const drawdown = drawdownFloor(locked.initial_capital);
    const kind = breachKind(equity, daily, drawdown);
    if (!kind && !breachId) return;
    if (kind && !breachId) {
      breachId = await insertBreach(
        client,
        accountId,
        kind,
        equity,
        kind === 'DAILY' ? daily : drawdown,
      );
      await client.query(
        `INSERT INTO risk_decisions (
           account_id, kind, decision, reason_code, equity, daily_floor, drawdown_floor
         ) VALUES ($1, 'BREACH', 'REJECT', $2, $3, $4, $5)`,
        [accountId, kind, equity, daily, drawdown],
      );
      await client.query(
        `INSERT INTO risk_stage_outcomes (account_id, outcome, reason)
         VALUES ($1, 'FAILED', $2)
         ON CONFLICT (account_id) DO NOTHING`,
        [accountId, kind],
      );
    }
  }
  if (!breachId) return;

  await closeOpenPositions(client, trading, {
    accountId,
    userId: locked.user_id,
    breachId,
    overlay,
  });
  if (locked.state === 'ACTIVE') await markFailed(client, accountId, breachId);
}

/** Timeout uses the same forced close as a floor breach. */
export async function failAccount(
  client: PoolClient,
  trading: RiskCloser,
  accountId: string,
  kind: 'TIMEOUT',
  overlay?: { instrumentId: string; bid: string; quote?: ExecutableQuote },
): Promise<void> {
  const account = await client.query<{ state: string; user_id: string }>(
    `SELECT state, user_id FROM trading_accounts WHERE id = $1 FOR UPDATE`,
    [accountId],
  );
  const locked = account.rows[0];
  if (!locked || (locked.state !== 'ACTIVE' && locked.state !== 'FAILED')) return;
  let breachId = await existingBreach(client, accountId);
  if (locked.state === 'ACTIVE' && !breachId) {
    breachId = await insertBreach(client, accountId, kind, null, null);
    await client.query(
      `INSERT INTO risk_decisions (account_id, kind, decision, reason_code)
       VALUES ($1, 'FAIL', 'REJECT', $2)`,
      [accountId, kind],
    );
    await client.query(
      `INSERT INTO risk_stage_outcomes (account_id, outcome, reason)
       VALUES ($1, 'FAILED', $2)
       ON CONFLICT (account_id) DO NOTHING`,
      [accountId, kind],
    );
  }
  if (!breachId) return;
  await closeOpenPositions(client, trading, {
    accountId,
    userId: locked.user_id,
    breachId,
    overlay,
  });
  if (locked.state === 'ACTIVE') await markFailed(client, accountId, breachId);
}

function breachKind(equity: string, daily: string, drawdown: string): 'DAILY' | 'DRAWDOWN' | null {
  const dailyHit = stressedBreaches(equity, daily);
  const drawdownHit = stressedBreaches(equity, drawdown);
  if (!dailyHit && !drawdownHit) return null;
  if (dailyHit && drawdownHit) {
    return decimalGreaterThan(daily, drawdown, MONEY) ? 'DAILY' : 'DRAWDOWN';
  }
  return dailyHit ? 'DAILY' : 'DRAWDOWN';
}

async function existingBreach(client: PoolClient, accountId: string): Promise<string | null> {
  const row = await client.query<{ id: string }>(
    `SELECT id FROM risk_breaches WHERE account_id = $1`,
    [accountId],
  );
  return row.rows[0]?.id ?? null;
}

async function insertBreach(
  client: PoolClient,
  accountId: string,
  kind: string,
  equity: string | null,
  floor: string | null,
): Promise<string | null> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO risk_breaches (account_id, kind, equity, floor)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id) DO NOTHING
     RETURNING id`,
    [accountId, kind, equity, floor],
  );
  return inserted.rows[0]?.id ?? (await existingBreach(client, accountId));
}

async function closeOpenPositions(
  client: PoolClient,
  trading: RiskCloser,
  args: {
    accountId: string;
    userId: string;
    breachId: string;
    overlay?: { instrumentId: string; bid: string; quote?: ExecutableQuote };
  },
): Promise<void> {
  const positions = await client.query<{
    id: string;
    instrument_id: string;
    quantity: string;
    reserved_sell: string;
    quantity_scale: number;
  }>(
    `SELECT positions.id, positions.instrument_id, positions.quantity::text,
            positions.reserved_sell::text, instruments.quantity_scale
     FROM positions
     JOIN instruments ON instruments.id = positions.instrument_id
     WHERE positions.account_id = $1 AND positions.status = 'OPEN' AND positions.quantity > 0
     ORDER BY positions.id
     FOR UPDATE OF positions`,
    [args.accountId],
  );
  for (const position of positions.rows) {
    await closeOne(client, trading, args, position);
  }
}

async function closeOne(
  client: PoolClient,
  trading: RiskCloser,
  args: {
    accountId: string;
    userId: string;
    breachId: string;
    overlay?: { instrumentId: string; bid: string; quote?: ExecutableQuote };
  },
  position: {
    id: string;
    instrument_id: string;
    quantity: string;
    reserved_sell: string;
    quantity_scale: number;
  },
): Promise<void> {
  const attempt = await client.query<{ id: string; order_id: string | null; state: string | null }>(
    `SELECT attempts.id, attempts.order_id, orders.state
     FROM risk_close_attempts AS attempts
     LEFT JOIN orders ON orders.id = attempts.order_id
     WHERE attempts.breach_id = $1 AND attempts.position_id = $2`,
    [args.breachId, position.id],
  );
  const prior = attempt.rows[0];
  if (prior && (await resolved(client, prior.id))) return;
  if (prior?.state === 'FILLED') {
    await resolve(client, prior.id, 'FILLED');
    return;
  }
  if (prior?.state === 'OPEN' || prior?.state === 'PARTIALLY_FILLED') return;

  const free = subtractDecimals(position.quantity, position.reserved_sell, position.quantity_scale);
  if (!decimalGreaterThan(free, '0', position.quantity_scale)) {
    if (!prior) await linkDeferred(client, args.breachId, position.id);
    return;
  }
  const quote = await closeQuote(client, position.instrument_id, args.overlay);
  if (!quote) {
    if (!prior) await insertAttempt(client, args.breachId, position.id, null);
    return;
  }
  const result = await trading.forceClose(client, {
    accountId: args.accountId,
    userId: args.userId,
    instrumentId: position.instrument_id,
    clientOrderId: `risk-${position.id}-${quote.quoteUpdateId}`,
    idempotencyKey: `risk-close:${args.breachId}:${position.id}:${quote.quoteUpdateId}`,
    side: 'SELL',
    orderType: 'MARKET',
    quantity: free,
    limitPrice: null,
    quote,
  });
  const attemptId =
    prior?.id ?? (await insertAttempt(client, args.breachId, position.id, result.orderId));
  if (result.state === 'FILLED') await resolve(client, attemptId, 'FILLED');
}

async function closeQuote(
  client: PoolClient,
  instrumentId: string,
  overlay?: { instrumentId: string; bid: string; quote?: ExecutableQuote },
): Promise<ExecutableQuote | null> {
  if (overlay?.quote && overlay.instrumentId === instrumentId) return overlay.quote;
  const row = await client.query<{
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
    `SELECT bid::text, ask::text, bid_size::text, ask_size::text, received_timestamp,
            feed_state, price_origin, provider_event_id, sequence_no::text
     FROM quote_snapshots WHERE instrument_id = $1`,
    [instrumentId],
  );
  const stored = row.rows[0];
  if (!stored) return null;
  const updateId = /^[0-9]+$/.test(stored.provider_event_id)
    ? stored.provider_event_id
    : stored.sequence_no;
  return {
    quoteUpdateId: updateId,
    bid: stored.bid,
    ask: stored.ask,
    bidSize: stored.bid_size,
    askSize: stored.ask_size,
    receivedAt: stored.received_timestamp,
    feedState: stored.feed_state,
    priceOrigin: stored.price_origin,
  };
}

async function linkDeferred(
  client: PoolClient,
  breachId: string,
  positionId: string,
): Promise<void> {
  const deferred = await client.query<{ order_id: string }>(
    `SELECT order_id FROM deferred_closes
     WHERE position_id = $1 AND state = 'AWAITING_FRESH'
     ORDER BY created_at LIMIT 1`,
    [positionId],
  );
  await insertAttempt(client, breachId, positionId, deferred.rows[0]?.order_id ?? null);
}

async function insertAttempt(
  client: PoolClient,
  breachId: string,
  positionId: string,
  orderId: string | null,
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO risk_close_attempts (breach_id, position_id, order_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (breach_id, position_id) DO NOTHING
     RETURNING id`,
    [breachId, positionId, orderId],
  );
  const id = inserted.rows[0]?.id;
  if (id) return id;
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM risk_close_attempts WHERE breach_id = $1 AND position_id = $2`,
    [breachId, positionId],
  );
  return existing.rows[0]?.id ?? randomUUID();
}

async function resolved(client: PoolClient, attemptId: string): Promise<boolean> {
  const row = await client.query(`SELECT 1 FROM risk_close_resolutions WHERE attempt_id = $1`, [
    attemptId,
  ]);
  return (row.rowCount ?? 0) > 0;
}

async function resolve(
  client: PoolClient,
  attemptId: string,
  outcome: 'FILLED' | 'FAILED',
): Promise<void> {
  await client.query(
    `INSERT INTO risk_close_resolutions (attempt_id, outcome)
     VALUES ($1, $2)
     ON CONFLICT (attempt_id) DO NOTHING`,
    [attemptId, outcome],
  );
}

async function markFailed(client: PoolClient, accountId: string, breachId: string): Promise<void> {
  await client.query(
    `INSERT INTO account_state_transitions (
       account_id, from_state, to_state, reason_code, reason, actor_type, idempotency_key
     ) VALUES ($1, 'ACTIVE', 'FAILED', 'RISK_BREACH', 'risk floor breach', 'SYSTEM', $2)`,
    [accountId, `breach:${breachId}`],
  );
  await client.query(`UPDATE trading_accounts SET state = 'FAILED' WHERE id = $1`, [accountId]);
}
