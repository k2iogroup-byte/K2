import { decimalsEqual } from '@k2/shared';
import type { Pool, PoolClient } from 'pg';

import { DEFAULT_STALE_OUTBOX_SECONDS } from '../../config/env.js';
import { ensureOpening, postedCash } from './drain.js';
import { absoluteMoneyDifference, canonicalMoney, founderCashSeverity } from './money.js';

const MONEY = 4;

export type ActorType = 'SYSTEM' | 'AI_AGENT' | 'SUPER_ADMIN';

export type ReconcileOptions = {
  now?: Date;
  staleAfterSeconds?: number;
};

type CashEvent = {
  event_type: string;
  severity: string;
};

/** Compare posted cash with the simulation projection. Unposted outbox rows are skipped. */
export async function reconcileLedger(pool: Pool, options: ReconcileOptions = {}): Promise<number> {
  const now = options.now ?? new Date();
  const staleAfterSeconds = options.staleAfterSeconds ?? DEFAULT_STALE_OUTBOX_SECONDS;
  await noteStaleOutbox(pool, now, staleAfterSeconds);
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
    if (await reconcileOne(pool, account.account_id)) mismatches += 1;
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

async function noteStaleOutbox(pool: Pool, now: Date, staleAfterSeconds: number): Promise<void> {
  const cutoff = new Date(now.getTime() - staleAfterSeconds * 1000);
  const stuck = await pool.query<{ id: string; account_id: string }>(
    `SELECT id, account_id
     FROM ledger_outbox
     WHERE posted_at IS NULL
       AND event_type IN ('fill', 'commission')
       AND created_at <= $1`,
    [cutoff],
  );
  if (stuck.rows.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of stuck.rows) {
      await client.query(
        `INSERT INTO mismatch_events (account_id, outbox_id, severity, event_type, actor_type)
         VALUES ($1, $2, 'WARNING', 'STALE_OUTBOX', 'SYSTEM')
         ON CONFLICT (outbox_id) WHERE event_type = 'STALE_OUTBOX' DO NOTHING`,
        [row.account_id, row.id],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function reconcileOne(pool: Pool, accountId: string): Promise<boolean> {
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
    const open = await latestCashEvent(client, accountId);
    if (decimalsEqual(expected, actual, MONEY)) {
      if (open && open.event_type !== 'RESOLVED') {
        await insertCashEvent(client, accountId, 'RESOLVED', 'INFO', expected, actual);
      }
      await client.query('COMMIT');
      return false;
    }
    const severity = founderCashSeverity(absoluteMoneyDifference(expected, actual));
    if (severity === 'CRITICAL') {
      if (open?.severity !== 'CRITICAL') {
        const mismatchId = await insertCashEvent(
          client,
          accountId,
          open?.event_type === 'OBSERVED' ? 'ESCALATED' : 'OBSERVED',
          'CRITICAL',
          expected,
          actual,
        );
        await freezeAccount(client, accountId, mismatchId);
      }
    } else if (open?.event_type === 'OBSERVED' && open.severity === 'WARNING') {
      const mismatchId = await insertCashEvent(
        client,
        accountId,
        'ESCALATED',
        'CRITICAL',
        expected,
        actual,
      );
      await freezeAccount(client, accountId, mismatchId);
    } else if (!open || open.event_type === 'RESOLVED') {
      await insertCashEvent(client, accountId, 'OBSERVED', 'WARNING', expected, actual);
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

async function latestCashEvent(client: PoolClient, accountId: string): Promise<CashEvent | null> {
  const row = await client.query<CashEvent>(
    `SELECT event_type, severity
     FROM mismatch_events
     WHERE account_id = $1
       AND event_type IN ('OBSERVED', 'ESCALATED', 'RESOLVED')
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [accountId],
  );
  return row.rows[0] ?? null;
}

async function insertCashEvent(
  client: PoolClient,
  accountId: string,
  eventType: 'OBSERVED' | 'ESCALATED' | 'RESOLVED',
  severity: 'INFO' | 'WARNING' | 'CRITICAL',
  expected: string,
  actual: string,
): Promise<string | undefined> {
  await client.query(
    `INSERT INTO mismatch_events (
       account_id, expected_amount, actual_amount, severity, event_type, actor_type
     ) VALUES ($1, $2, $3, $4, $5, 'SYSTEM')`,
    [accountId, expected, actual, severity, eventType],
  );
  if (eventType === 'RESOLVED') return undefined;
  const logged = await client.query<{ id: string }>(
    `INSERT INTO mismatch_log (
       account_id, expected_amount, actual_amount, severity, kind, source_module, actor_type
     ) VALUES ($1, $2, $3, $4, 'CASH_MISMATCH', 'M07', 'SYSTEM')
     RETURNING id`,
    [accountId, expected, actual, severity],
  );
  return logged.rows[0]?.id;
}

async function freezeAccount(
  client: PoolClient,
  accountId: string,
  mismatchId: string | undefined,
): Promise<void> {
  if (!mismatchId || (await freezeIsActive(client, accountId))) return;
  await client.query(
    `INSERT INTO ledger_freezes (account_id, mismatch_log_id, actor_type)
     VALUES ($1, $2, 'SYSTEM')`,
    [accountId, mismatchId],
  );
}
