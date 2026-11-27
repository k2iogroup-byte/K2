import { canonicalDecimal, decimalGreaterThan, multiplyDecimals } from '@k2/shared';
import type { Pool, PoolClient } from 'pg';

import type { ExecutableQuote } from '../trading/trading-service.js';
import { failAccount, type RiskCloser } from './breach.js';

const MONEY = 4;
const DAY_MS = 86_400_000;
const PASSING_DAYS = 7;

export function stageRules(stage: string): { factor: string; limitDays: number } {
  if (stage === 'STAGE_2') return { factor: '1.0500', limitDays: 60 };
  return { factor: '1.0800', limitDays: 30 };
}

/**
 * Stage result from closed balance, trading days, and the time limit.
 * The day-open equity mark is recorded on evaluation and does not use this timer.
 */
export async function evaluateProgress(
  client: PoolClient,
  trading: RiskCloser,
  accountId: string,
  now: Date,
  overlay?: { instrumentId: string; bid: string; quote?: ExecutableQuote },
): Promise<void> {
  const account = await client.query<{ state: string; stage: string; initial_capital: string }>(
    `SELECT state, stage, initial_capital::text
     FROM trading_accounts WHERE id = $1 FOR UPDATE`,
    [accountId],
  );
  const locked = account.rows[0];
  if (!locked || locked.state !== 'ACTIVE') return;
  await syncTradingDays(client, accountId);
  const rules = stageRules(locked.stage);
  if (await targetReached(client, accountId, locked.initial_capital, rules.factor)) {
    await markPassed(client, accountId, locked.stage);
    return;
  }
  if (await timedOut(client, accountId, rules.limitDays, now)) {
    await failAccount(client, trading, accountId, 'TIMEOUT', overlay);
  }
}

export async function reviewStages(pool: Pool, trading: RiskCloser): Promise<void> {
  const accounts = await pool.query<{ id: string }>(
    `SELECT id FROM trading_accounts WHERE state = 'ACTIVE'`,
  );
  for (const row of accounts.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await evaluateProgress(client, trading, row.id, new Date());
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

async function syncTradingDays(client: PoolClient, accountId: string): Promise<void> {
  await client.query(
    `INSERT INTO risk_trading_days (account_id, utc_date, first_execution_id)
     SELECT DISTINCT ON ((executed_at AT TIME ZONE 'UTC')::date)
       account_id, (executed_at AT TIME ZONE 'UTC')::date, id
     FROM executions
     WHERE account_id = $1
     ORDER BY (executed_at AT TIME ZONE 'UTC')::date, executed_at, id
     ON CONFLICT (account_id, utc_date) DO NOTHING`,
    [accountId],
  );
}

async function targetReached(
  client: PoolClient,
  accountId: string,
  initial: string,
  factor: string,
): Promise<boolean> {
  const open = await client.query(
    `SELECT 1 FROM positions
     WHERE account_id = $1 AND status = 'OPEN' AND quantity > 0
     LIMIT 1`,
    [accountId],
  );
  if ((open.rowCount ?? 0) > 0) return false;
  const days = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM risk_trading_days WHERE account_id = $1`,
    [accountId],
  );
  if (BigInt(days.rows[0]?.count ?? '0') < BigInt(PASSING_DAYS)) return false;
  const cash = await client.query<{ cash: string }>(
    `SELECT cash::text FROM simulation_cash_projections WHERE account_id = $1`,
    [accountId],
  );
  const balance = cash.rows[0]?.cash ?? initial;
  const target = multiplyDecimals(canonicalDecimal(initial, MONEY), factor, MONEY, MONEY, MONEY);
  return !decimalGreaterThan(target, balance, MONEY);
}

async function timedOut(
  client: PoolClient,
  accountId: string,
  limitDays: number,
  now: Date,
): Promise<boolean> {
  const first = await client.query<{ executed_at: Date }>(
    `SELECT min(executed_at) AS executed_at FROM executions WHERE account_id = $1`,
    [accountId],
  );
  const started = first.rows[0]?.executed_at;
  if (!started) return false;
  return now.getTime() >= started.getTime() + limitDays * DAY_MS;
}

async function markPassed(client: PoolClient, accountId: string, stage: string): Promise<void> {
  await client.query(
    `INSERT INTO account_state_transitions (
       account_id, from_state, to_state, reason_code, reason, actor_type, idempotency_key
     ) VALUES ($1, 'ACTIVE', 'PASSED', 'STAGE_PASSED', 'stage target reached', 'SYSTEM', $2)`,
    [accountId, `pass:${accountId}`],
  );
  await client.query(`UPDATE trading_accounts SET state = 'PASSED' WHERE id = $1`, [accountId]);
  await client.query(
    `INSERT INTO risk_stage_outcomes (account_id, outcome, reason)
     VALUES ($1, 'PASSED', $2)
     ON CONFLICT (account_id) DO NOTHING`,
    [accountId, stage],
  );
  await client.query(
    `INSERT INTO risk_decisions (account_id, kind, decision, reason_code)
     VALUES ($1, 'PASS', 'APPROVE', 'STAGE_PASSED')`,
    [accountId],
  );
}
