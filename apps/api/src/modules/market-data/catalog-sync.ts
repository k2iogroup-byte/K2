import type { Pool, PoolClient } from 'pg';

import { instrumentScale } from './exchange-filters.js';

export const CATALOG_REFRESH_MS = 15 * 60 * 1000;

export type CatalogLock = { fillsAllowed(): boolean };

type ParsedSymbol = {
  symbol: string;
  providerSymbol: string;
  status: 'TRADING' | 'BREAK' | 'HALT' | 'DELISTED';
  tickSize: string;
  stepSize: string;
  minQty: string;
  maxQty: string;
  minNotional: string;
};

export type CatalogSyncResult = {
  tradable: number;
  halted: number;
  ignored: number;
};

export function parseExchangeInfo(payload: unknown): ParsedSymbol[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const symbols = (payload as { symbols?: unknown }).symbols;
  if (!Array.isArray(symbols)) return [];
  const parsed: ParsedSymbol[] = [];
  for (const entry of symbols) {
    const row = readSymbol(entry);
    if (row) parsed.push(row);
  }
  return parsed;
}

export async function syncExchangeCatalog(
  pool: Pool,
  payload: unknown,
): Promise<CatalogSyncResult> {
  const rows = parseExchangeInfo(payload);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let tradable = 0;
    let halted = 0;
    let ignored = 0;
    const trading = new Set<string>();
    for (const row of rows) {
      if (row.status === 'TRADING') {
        trading.add(row.symbol);
        await upsert(client, row, 'TRADABLE');
        tradable += 1;
      } else {
        await upsert(client, row, 'HALTED');
        halted += 1;
      }
    }
    const retired = await client.query(
      `UPDATE instruments
          SET trading_status = 'HALTED'
        WHERE market = 'CRYPTO'
          AND venue = 'BINANCE_SPOT'
          AND trading_status <> 'HALTED'
          AND id IN (SELECT instrument_id FROM instrument_exchange_filters)
          AND NOT (symbol = ANY($1::text[]))`,
      [Array.from(trading)],
    );
    halted += retired.rowCount ?? 0;
    ignored = Array.isArray((payload as { symbols?: unknown }).symbols)
      ? (payload as { symbols: unknown[] }).symbols.length - rows.length
      : 0;
    await client.query('COMMIT');
    return { tradable, halted, ignored };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function startCatalogSync(options: {
  pool: Pool;
  lock: CatalogLock | null;
  load: () => Promise<unknown>;
  intervalMs?: number;
}): { stop: () => void } {
  if (!options.lock?.fillsAllowed()) return { stop: () => undefined };
  let stopped = false;
  const run = (): void => {
    if (stopped || !options.lock?.fillsAllowed()) return;
    void options
      .load()
      .then((payload) => {
        if (stopped || payload === null || !options.lock?.fillsAllowed()) return;
        return syncExchangeCatalog(options.pool, payload);
      })
      .catch(() => undefined);
  };
  run();
  const timer = setInterval(run, options.intervalMs ?? CATALOG_REFRESH_MS);
  timer.unref();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function readSymbol(entry: unknown): ParsedSymbol | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const row = entry as Record<string, unknown>;
  if (row.quoteAsset !== 'USDT' || typeof row.symbol !== 'string') return null;
  if (!/^[A-Z0-9][A-Z0-9.-]{0,31}$/.test(row.symbol)) return null;
  const status = exchangeStatus(row.status);
  if (!status) return null;
  const filters = Array.isArray(row.filters) ? row.filters : [];
  const price = filter(filters, 'PRICE_FILTER');
  const lot = filter(filters, 'LOT_SIZE');
  const notional = filter(filters, 'NOTIONAL') ?? filter(filters, 'MIN_NOTIONAL');
  const tickSize = text(price?.tickSize);
  const stepSize = text(lot?.stepSize);
  const minQty = text(lot?.minQty);
  const maxQty = text(lot?.maxQty);
  const minNotional = text(notional?.minNotional);
  if (!tickSize || !stepSize || !minQty || !maxQty || !minNotional) return null;
  return {
    symbol: row.symbol,
    providerSymbol: row.symbol.toLowerCase(),
    status,
    tickSize,
    stepSize,
    minQty,
    maxQty,
    minNotional,
  };
}

function exchangeStatus(value: unknown): ParsedSymbol['status'] | null {
  if (value === 'TRADING' || value === 'BREAK' || value === 'HALT' || value === 'DELISTED') {
    return value;
  }
  if (typeof value === 'string') return 'DELISTED';
  return null;
}

function filter(filters: unknown[], type: string): Record<string, unknown> | null {
  for (const entry of filters) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { filterType?: string }).filterType === type
    ) {
      return entry as Record<string, unknown>;
    }
  }
  return null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value.trim())) return null;
  return value.trim();
}

async function upsert(
  client: PoolClient,
  row: ParsedSymbol,
  tradingStatus: 'TRADABLE' | 'HALTED',
): Promise<void> {
  const saved = await client.query<{ id: string }>(
    `INSERT INTO instruments (
       market, venue, symbol, provider_symbol, price_scale, quantity_scale, trading_status, quote_asset
     ) VALUES ('CRYPTO', 'BINANCE_SPOT', $1, $2, $3, $4, $5, 'USDT')
     ON CONFLICT (symbol) DO UPDATE
       SET trading_status = EXCLUDED.trading_status,
           price_scale = EXCLUDED.price_scale,
           quantity_scale = EXCLUDED.quantity_scale,
           quote_asset = EXCLUDED.quote_asset
       WHERE instruments.market = 'CRYPTO' AND instruments.venue = 'BINANCE_SPOT'
     RETURNING id`,
    [
      row.symbol,
      row.providerSymbol,
      instrumentScale(row.tickSize),
      instrumentScale(row.stepSize),
      tradingStatus,
    ],
  );
  const id = saved.rows[0]?.id;
  if (!id) return;
  await client.query(
    `INSERT INTO instrument_exchange_filters (
       instrument_id, tick_size, step_size, min_qty, max_qty, min_notional, exchange_status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (instrument_id) DO UPDATE
       SET tick_size = EXCLUDED.tick_size,
           step_size = EXCLUDED.step_size,
           min_qty = EXCLUDED.min_qty,
           max_qty = EXCLUDED.max_qty,
           min_notional = EXCLUDED.min_notional,
           exchange_status = EXCLUDED.exchange_status,
           updated_at = now()`,
    [id, row.tickSize, row.stepSize, row.minQty, row.maxQty, row.minNotional, row.status],
  );
}
