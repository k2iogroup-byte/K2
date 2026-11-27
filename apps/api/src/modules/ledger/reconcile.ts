import { decimalsEqual } from '@k2/shared';
import type { Pool, PoolClient } from 'pg';

import { ensureOpening, postedCash } from './drain.js';
import { canonicalMoney, mismatchSeverity, type SeverityBands } from './money.js';

const MONEY = 4;

export type ActorType = 'SYSTEM' | 'AI_AGENT' | 'SUPER_ADMIN';

/** Compare posted cash with the simulation projection. Unposted outbox rows are skipped. */
export async function reconcileLedger(pool: Pool, bands?: SeverityBands): Promise<number> {
  const accounts = await pool.query<{ account_id: string }>(
    `SELECT projections.account_id
     FROM simulation_cash_projections AS projections
     WHERE NOT EXISTS (
       SELECT 1 FROM ledger_outbox AS outbox
       WHERE outbox.account_id = projections.account_id
         AND outbox.posted_at IS NULL
         AND outbox.event_type IN ('fill', 'commission')
     )`,
  );
  let mismatches = 0;
  for (const account of accounts.rows) {
    if (await reconcileOne(pool, account.account_id, bands)) mismatches += 1;
  }
  return mismatches;
}

export async function freezeIsActive(client: PoolClient, accountId: string): Promise<boolean> {
  const row = await client.query(
    `SELECT 1
     FROM ledger_freezes AS held
     WHERE held.account_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM ledger_freeze_lifts AS lifted WHERE lifted.freeze_id = held.id
       )
     LIMIT 1`,
    [accountId],
  );
  return (row.rowCount ?? 0) > 0;
}

/** Append a lift. Matching balances do not call this. */
export async function liftLedgerFreeze(
  client: PoolClient,
  accountId: string,
  actor: ActorType,
): Promise<boolean> {
  const freeze = await client.query<{ id: string }>(
    `SELECT held.id
     FROM ledger_freezes AS held
     WHERE held.account_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM ledger_freeze_lifts AS lifted WHERE lifted.freeze_id = held.id
       )
     ORDER BY held.created_at, held.id
     LIMIT 1`,
    [accountId],
  );
  const id = freeze.rows[0]?.id;
  if (!id) return false;
  await client.query(
    `INSERT INTO ledger_freeze_lifts (freeze_id, actor_type) VALUES ($1, $2)
     ON CONFLICT (freeze_id) DO NOTHING`,
    [id, actor],
  );
  return true;
}

async function reconcileOne(
  pool: Pool,
  accountId: string,
  bands?: SeverityBands,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pending = await client.query(
      `SELECT 1 FROM ledger_outbox
       WHERE account_id = $1 AND posted_at IS NULL
         AND event_type IN ('fill', 'commission')
       LIMIT 1`,
      [accountId],
    );
    if ((pending.rowCount ?? 0) > 0) {
      await client.query('COMMIT');
      return false;
    }
    await ensureOpening(client, accountId);
    const projection = await client.query<{ cash: string }>(
      `SELECT cash::text FROM simulation_cash_projections WHERE account_id = $1`,
      [accountId],
    );
    const expected = canonicalMoney(projection.rows[0]?.cash ?? '0');
    const actual = await postedCash(client, accountId);
    if (decimalsEqual(expected, actual, MONEY)) {
      await client.query('COMMIT');
      return false;
    }
    const severity = mismatchSeverity(expected, actual, bands);
    const logged = await client.query<{ id: string }>(
      `INSERT INTO mismatch_log (
         account_id, expected_amount, actual_amount, severity, kind, source_module, actor_type
       ) VALUES ($1, $2, $3, $4, 'CASH_MISMATCH', 'M07', 'SYSTEM')
       RETURNING id`,
      [accountId, expected, actual, severity],
    );
    const mismatchId = logged.rows[0]?.id;
    if (mismatchId && !(await freezeIsActive(client, accountId))) {
      await client.query(
        `INSERT INTO ledger_freezes (account_id, mismatch_log_id, actor_type)
         VALUES ($1, $2, 'SYSTEM')`,
        [accountId, mismatchId],
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
