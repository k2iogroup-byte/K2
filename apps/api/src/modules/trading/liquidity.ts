import {
  addDecimals,
  canonicalDecimal,
  decimalGreaterThan,
  decimalLessThan,
  subtractDecimals,
} from '@k2/shared';
import type { PoolClient } from 'pg';

export type LiquidityTake = {
  quantity: string;
  displayed: string;
  consumedBefore: string;
  consumedAfter: string;
  price: string;
  quoteUpdateId: string;
  bookSide: 'BID' | 'ASK';
  source: string;
};

export function liquiditySource(priceOrigin: 'TEST_FIXTURE' | 'VENDOR'): string {
  return priceOrigin === 'VENDOR' ? 'binance-public:bookTicker' : 'test-fixture';
}

/**
 * Shared top-of-book budget. An update id that is not newer does not restore size.
 * When the same price returns, earlier consumption at that price still counts.
 */
export async function takeLiquidity(
  client: PoolClient,
  input: {
    instrumentId: string;
    source: string;
    bookSide: 'BID' | 'ASK';
    price: string;
    priceScale: number;
    quoteUpdateId: string;
    displayed: string;
    want: string;
    quantityScale: number;
  },
): Promise<LiquidityTake> {
  const price = canonicalDecimal(input.price, input.priceScale);
  const displayed = canonicalDecimal(input.displayed, input.quantityScale);
  const want = canonicalDecimal(input.want, input.quantityScale);
  const scale = input.quantityScale;
  await client.query(
    `INSERT INTO instrument_quote_cursors (instrument_id, source, last_update_id)
     VALUES ($1, $2, '0')
     ON CONFLICT (instrument_id, source) DO NOTHING`,
    [input.instrumentId, input.source],
  );
  const cursor = await client.query<{ last_update_id: string }>(
    `SELECT last_update_id FROM instrument_quote_cursors
     WHERE instrument_id = $1 AND source = $2
     FOR UPDATE`,
    [input.instrumentId, input.source],
  );
  const storedUpdate = cursor.rows[0]?.last_update_id ?? '0';
  const newer = BigInt(input.quoteUpdateId) > BigInt(storedUpdate);
  if (newer) {
    await client.query(
      `INSERT INTO liquidity_levels (
         instrument_id, source, book_side, price, quote_update_id, displayed_qty, consumed_qty
       ) VALUES ($1, $2, $3, $4, $5, $6, 0)
       ON CONFLICT (instrument_id, source, book_side, price) DO UPDATE
         SET displayed_qty = EXCLUDED.displayed_qty,
             quote_update_id = EXCLUDED.quote_update_id,
             updated_at = now()`,
      [input.instrumentId, input.source, input.bookSide, price, input.quoteUpdateId, displayed],
    );
    await client.query(
      `UPDATE instrument_quote_cursors
       SET last_update_id = $3, updated_at = now()
       WHERE instrument_id = $1 AND source = $2`,
      [input.instrumentId, input.source, input.quoteUpdateId],
    );
  }
  const level = await client.query<{ displayed_qty: string; consumed_qty: string }>(
    `SELECT displayed_qty::text, consumed_qty::text
     FROM liquidity_levels
     WHERE instrument_id = $1 AND source = $2 AND book_side = $3 AND price = $4
     FOR UPDATE`,
    [input.instrumentId, input.source, input.bookSide, price],
  );
  const row = level.rows[0];
  if (!row || !decimalGreaterThan(want, '0', scale)) {
    return emptyTake(input, price, displayed);
  }
  const consumedBefore = canonicalDecimal(row.consumed_qty, scale);
  const shown = canonicalDecimal(row.displayed_qty, scale);
  const rawAvailable = subtractDecimals(shown, consumedBefore, scale);
  const available = decimalLessThan(rawAvailable, '0', scale)
    ? canonicalDecimal('0', scale)
    : rawAvailable;
  const quantity = decimalLessThan(want, available, scale) ? want : available;
  const consumedAfter = decimalGreaterThan(quantity, '0', scale)
    ? addDecimals(consumedBefore, quantity, scale)
    : consumedBefore;
  if (decimalGreaterThan(quantity, '0', scale)) {
    await client.query(
      `UPDATE liquidity_levels
       SET consumed_qty = $5, updated_at = now()
       WHERE instrument_id = $1 AND source = $2 AND book_side = $3 AND price = $4`,
      [input.instrumentId, input.source, input.bookSide, price, consumedAfter],
    );
  }
  return {
    quantity,
    displayed: shown,
    consumedBefore,
    consumedAfter,
    price,
    quoteUpdateId: input.quoteUpdateId,
    bookSide: input.bookSide,
    source: input.source,
  };
}

function emptyTake(
  input: { quoteUpdateId: string; bookSide: 'BID' | 'ASK'; source: string; quantityScale: number },
  price: string,
  displayed: string,
): LiquidityTake {
  const zero = canonicalDecimal('0', input.quantityScale);
  return {
    quantity: zero,
    displayed,
    consumedBefore: zero,
    consumedAfter: zero,
    price,
    quoteUpdateId: input.quoteUpdateId,
    bookSide: input.bookSide,
    source: input.source,
  };
}
