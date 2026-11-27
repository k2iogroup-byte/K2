import type { PoolClient } from 'pg';

import { negateMoney } from './money.js';
import type { ActorType } from './reconcile.js';

/** Append the opposite amount. The original row is not updated. */
export async function postReversal(
  client: PoolClient,
  originalId: string,
  actor: ActorType,
): Promise<string | null> {
  const original = await client.query<{
    account_id: string;
    amount: string;
    cash_effect: boolean;
  }>(
    `SELECT account_id, amount::text, cash_effect
     FROM journal_entries WHERE id = $1`,
    [originalId],
  );
  const row = original.rows[0];
  if (!row) return null;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO journal_entries (
       account_id, entry_type, amount, cash_effect, idempotency_key, reverses_id, actor_type
     ) VALUES ($1, 'REVERSAL', $2, $3, $4, $5, $6)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      row.account_id,
      negateMoney(row.amount),
      row.cash_effect,
      `reversal:${originalId}`,
      originalId,
      actor,
    ],
  );
  return inserted.rows[0]?.id ?? null;
}
