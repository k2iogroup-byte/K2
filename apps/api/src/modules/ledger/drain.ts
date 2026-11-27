import { canonicalDecimal, decimalGreaterThan } from '@k2/shared';
import type { Pool, PoolClient } from 'pg';

import { canonicalMoney, negateMoney } from './money.js';

const MONEY = 4;
const ZERO = '0.0000';

type OutboxRow = {
  id: string;
  event_type: string;
  idempotency_key: string;
  account_id: string;
  execution_id: string | null;
  amount: string;
  side: string | null;
};

/** Post unposted outbox rows. A repeated key does not create a second journal row. */
export async function drainLedger(pool: Pool): Promise<number> {
  let posted = 0;
  const skipped = new Set<string>();
  for (;;) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await lockNext(client, skipped);
      if (!row) {
        await client.query('COMMIT');
        return posted;
      }
      const wrote = await postRow(client, row);
      if (!wrote) skipped.add(row.id);
      else posted += 1;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function postedCash(client: PoolClient, accountId: string): Promise<string> {
  const row = await client.query<{ amount: string | null }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS amount
     FROM journal_entries
     WHERE account_id = $1 AND cash_effect`,
    [accountId],
  );
  return canonicalMoney(row.rows[0]?.amount ?? ZERO);
}

async function lockNext(
  client: PoolClient,
  skipped: ReadonlySet<string>,
): Promise<OutboxRow | null> {
  const row = await client.query<OutboxRow>(
    `SELECT outbox.id, outbox.event_type, outbox.idempotency_key, outbox.account_id,
            outbox.execution_id, outbox.amount::text AS amount, orders.side
     FROM ledger_outbox AS outbox
     LEFT JOIN executions ON executions.id = outbox.execution_id
     LEFT JOIN orders ON orders.id = executions.order_id
     WHERE outbox.posted_at IS NULL
       AND outbox.event_type IN ('fill', 'commission')
       AND NOT (outbox.id = ANY($1::uuid[]))
     ORDER BY outbox.created_at, outbox.id
     LIMIT 1
     FOR UPDATE OF outbox SKIP LOCKED`,
    [skipped.size === 0 ? [] : [...skipped]],
  );
  return row.rows[0] ?? null;
}

async function postRow(client: PoolClient, row: OutboxRow): Promise<boolean> {
  if (row.event_type === 'fill' && (row.execution_id === null || row.side === null)) return false;
  if (row.event_type === 'commission' && row.execution_id === null) return false;
  const amount = canonicalDecimal(row.amount, MONEY);
  if (row.event_type === 'commission' && !decimalGreaterThan(amount, ZERO, MONEY)) {
    await markPosted(client, row.id);
    return true;
  }
  await ensureOpening(client, row.account_id);
  const signed =
    row.event_type === 'commission' ? negateMoney(amount) : signedFill(row.side, amount);
  if (!signed) return false;
  const entryType = row.event_type === 'commission' ? 'COMMISSION' : 'FILL';
  await client.query(
    `INSERT INTO journal_entries (
       account_id, entry_type, amount, cash_effect, idempotency_key, outbox_id, execution_id, actor_type
     ) VALUES ($1, $2, $3, true, $4, $5, $6, 'SYSTEM')
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [row.account_id, entryType, signed, row.idempotency_key, row.id, row.execution_id],
  );
  await markPosted(client, row.id);
  return true;
}

function signedFill(side: string | null, amount: string): string | null {
  if (side === 'SELL') return canonicalMoney(amount);
  if (side === 'BUY') return negateMoney(amount);
  return null;
}

async function ensureOpening(client: PoolClient, accountId: string): Promise<void> {
  await client.query(
    `INSERT INTO journal_entries (
       account_id, entry_type, amount, cash_effect, idempotency_key, actor_type
     )
     SELECT id, 'OPENING', initial_capital, true, 'opening:' || id::text, 'SYSTEM'
     FROM trading_accounts
     WHERE id = $1
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [accountId],
  );
}

async function markPosted(client: PoolClient, outboxId: string): Promise<void> {
  await client.query(
    `UPDATE ledger_outbox
     SET posted_at = transaction_timestamp()
     WHERE id = $1 AND posted_at IS NULL`,
    [outboxId],
  );
}
