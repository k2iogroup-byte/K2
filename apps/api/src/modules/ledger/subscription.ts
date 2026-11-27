import { canonicalDecimal, decimalGreaterThan, divideByInt } from '@k2/shared';
import type { Pool, PoolClient } from 'pg';

const MONEY = 4;
const PERIOD_MS = 30 * 86_400_000;
const MAX_PERIODS = 120;

/** Accrue subscription charges for ACTIVE accounts. FAILED and PASSED are skipped. */
export async function accrueSubscriptions(pool: Pool, now: Date): Promise<number> {
  const accounts = await pool.query<{ id: string; initial_capital: string; first_at: Date }>(
    `SELECT accounts.id, accounts.initial_capital::text AS initial_capital,
            MIN(executions.executed_at) AS first_at
     FROM trading_accounts AS accounts
     JOIN executions ON executions.account_id = accounts.id
     WHERE accounts.state = 'ACTIVE'
     GROUP BY accounts.id`,
  );
  let created = 0;
  for (const account of accounts.rows) {
    created += await accrueOne(pool, account, now);
  }
  return created;
}

async function accrueOne(
  pool: Pool,
  account: { id: string; initial_capital: string; first_at: Date },
  now: Date,
): Promise<number> {
  const amount = divideByInt(canonicalDecimal(account.initial_capital, MONEY), MONEY, 1000n, MONEY);
  if (!decimalGreaterThan(amount, '0', MONEY)) return 0;
  let created = 0;
  let start = account.first_at.getTime();
  for (let index = 0; index < MAX_PERIODS && start <= now.getTime(); index += 1) {
    const end = start + PERIOD_MS;
    if (await writeCharge(pool, account.id, new Date(start), new Date(end), amount)) created += 1;
    start = end;
  }
  return created;
}

async function writeCharge(
  pool: Pool,
  accountId: string,
  periodStart: Date,
  periodEnd: Date,
  amount: string,
): Promise<boolean> {
  const key = `subscription:${accountId}:${periodStart.toISOString()}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await insertCharge(client, accountId, periodStart, periodEnd, amount, key);
    if (!inserted) {
      await client.query('COMMIT');
      return false;
    }
    await client.query(
      `INSERT INTO journal_entries (
         account_id, entry_type, amount, cash_effect, idempotency_key, actor_type
       ) VALUES ($1, 'SUBSCRIPTION', $2, false, $3, 'SYSTEM')
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [accountId, amount, key],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function insertCharge(
  client: PoolClient,
  accountId: string,
  periodStart: Date,
  periodEnd: Date,
  amount: string,
  key: string,
): Promise<boolean> {
  const row = await client.query(
    `INSERT INTO subscription_charges (
       account_id, period_start, period_end, amount, idempotency_key, actor_type
     ) VALUES ($1, $2, $3, $4, $5, 'SYSTEM')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [accountId, periodStart, periodEnd, amount, key],
  );
  return (row.rowCount ?? 0) > 0;
}
