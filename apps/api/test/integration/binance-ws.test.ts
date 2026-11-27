import { randomUUID } from 'node:crypto';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiPackageRoot } from '../../src/config/paths.js';
import { migrateUp } from '../../src/infrastructure/db/migrator.js';
import {
  openLiveBookTickerFeed,
  type SocketLike,
} from '../../src/modules/market-data/binance-spot-ws.js';
import { MarketDataEngine } from '../../src/modules/market-data/engine.js';
import { MarketDataStore } from '../../src/modules/market-data/store.js';
import { Phase2Orders } from '../../src/modules/trading/phase2-orders.js';
import { bindTradingQuotes } from '../../src/modules/trading/quote-bridge.js';
import { TradingService } from '../../src/modules/trading/trading-service.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a database whose name ends with _test');
if (!new URL(databaseUrl).pathname.replace(/^\//, '').endsWith('_test')) {
  throw new Error(
    'Refusing to run integration tests against a database whose name does not end with _test',
  );
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

class MockSocket implements SocketLike {
  readonly sent: string[] = [];
  private message: ((data: string) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    return undefined;
  }

  onMessage(handler: (data: string) => void): void {
    this.message = handler;
  }

  onClose(): void {
    return undefined;
  }

  receive(data: string): void {
    this.message?.(data);
  }
}

describe('mocked binance websocket quotes', () => {
  beforeAll(async () => {
    await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('writes one USDT bookTicker into the quote pipeline and does not open a network socket', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
    const symbol = `W${suffix}USDT`;
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO instruments (
         market, venue, symbol, provider_symbol, price_scale, quantity_scale, trading_status, quote_asset
       ) VALUES ('CRYPTO', 'BINANCE_SPOT', $1, $2, 2, 8, 'TRADABLE', 'USDT')
       RETURNING id`,
      [symbol, symbol.toLowerCase()],
    );
    const instrumentId = inserted.rows[0]?.id;
    if (!instrumentId) throw new Error('instrument insert returned no id');
    const store = new MarketDataStore(pool);
    const engine = new MarketDataEngine(
      { providerId: 'binance-public', priceOrigin: 'VENDOR', sink: store },
      [
        {
          id: instrumentId,
          market: 'CRYPTO',
          venue: 'BINANCE_SPOT',
          symbol,
          providerSymbol: symbol.toLowerCase(),
          priceScale: 2,
          quantityScale: 8,
        },
      ],
    );
    const quotes: string[] = [];
    const phase2 = new Phase2Orders(pool, new TradingService(pool), null, false);
    const bridge = bindTradingQuotes(engine, phase2);
    const original = phase2.onQuote.bind(phase2);
    phase2.onQuote = (id, quote) => {
      quotes.push(quote.quoteUpdateId);
      return original(id, quote);
    };
    const socket = new MockSocket();
    let connects = 0;
    let ingested: Promise<unknown> = Promise.resolve();
    const receivedAt = new Date('2026-11-21T12:00:00.000Z');
    const feed = openLiveBookTickerFeed({
      mode: 'binance-public',
      connect: () => {
        connects += 1;
        return socket;
      },
      clock: {
        now: () => receivedAt.getTime(),
        delay: () => () => undefined,
      },
      onEvent: (event) => {
        ingested = ingested.then(() => engine.ingest(event, receivedAt));
      },
    });
    feed?.subscribe([symbol, 'ETHUSDC']);
    socket.receive(
      `{"u":44,"s":"${symbol}","b":"10.00","B":"1.00000000","a":"10.10","A":"2.00000000"}`,
    );
    await ingested;
    await bridge.idle();
    expect(connects).toBe(1);
    expect(socket.sent.join(' ')).toContain(`${symbol.toLowerCase()}@bookTicker`);
    expect(socket.sent.join(' ')).not.toContain('ethusdc');
    expect(quotes).toEqual(['44']);
    const stored = await pool.query<{ bid: string; ask: string }>(
      `SELECT bid::text, ask::text FROM quote_snapshots WHERE instrument_id = $1`,
      [instrumentId],
    );
    expect(stored.rows[0]).toEqual({ bid: '10.00000000', ask: '10.10000000' });
    expect(
      openLiveBookTickerFeed({
        mode: 'disconnected',
        connect: () => {
          throw new Error('disconnected mode must not connect');
        },
        onEvent: () => undefined,
      }),
    ).toBeNull();
    feed?.stop();
  });
});
