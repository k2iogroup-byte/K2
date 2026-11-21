import type { Pool, PoolClient } from 'pg';

import { liquiditySource } from './liquidity.js';
import type { ExecutableQuote } from './trading-service.js';

export function triggerQuoteSource(quote: Pick<ExecutableQuote, 'priceOrigin'>): string {
  return liquiditySource(quote.priceOrigin);
}

export async function triggerQuoteIsNew(
  db: Pool | PoolClient,
  instrumentId: string,
  quote: ExecutableQuote,
): Promise<boolean> {
  if (!/^[0-9]+$/.test(quote.quoteUpdateId)) return false;
  const row = await db.query<{ last_update_id: string }>(
    `SELECT last_update_id::text
       FROM trigger_quote_cursor
      WHERE instrument_id = $1 AND source = $2`,
    [instrumentId, triggerQuoteSource(quote)],
  );
  const last = row.rows[0]?.last_update_id;
  if (!last) return true;
  return BigInt(quote.quoteUpdateId) > BigInt(last);
}

/** Advance in the caller's transaction. Never moves the cursor backwards. */
export async function advanceTriggerCursor(
  client: PoolClient,
  instrumentId: string,
  quote: ExecutableQuote,
): Promise<void> {
  if (!/^[0-9]+$/.test(quote.quoteUpdateId)) return;
  await client.query(
    `INSERT INTO trigger_quote_cursor (instrument_id, source, last_update_id)
     VALUES ($1, $2, $3::numeric)
     ON CONFLICT (instrument_id, source) DO UPDATE
       SET last_update_id = GREATEST(trigger_quote_cursor.last_update_id, EXCLUDED.last_update_id),
           updated_at = now()
     WHERE trigger_quote_cursor.last_update_id <= EXCLUDED.last_update_id`,
    [instrumentId, triggerQuoteSource(quote), quote.quoteUpdateId],
  );
}
