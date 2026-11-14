import { describe, expect, it } from 'vitest';

import { BinancePublicProvider } from '../../src/modules/market-data/binance-public-provider.js';
import { MarketDataEngine } from '../../src/modules/market-data/engine.js';
import { backoffDelayMs, retryAfterDelayMs } from '../../src/modules/market-data/feed-reconnect.js';

const btc = {
  id: '00000000-0000-4000-8000-0000000000b1',
  market: 'CRYPTO' as const,
  venue: 'BINANCE_SPOT' as const,
  symbol: 'BTCUSDT',
  providerSymbol: 'btcusdt',
  priceScale: 2,
  quantityScale: 8,
};

const recorded = {
  fixture: 'RECORDED_FIXTURE_NOT_LIVE_MARKET_DATA' as const,
  u: '10',
  s: 'BTCUSDT',
  b: '1.00',
  B: '1',
  a: '1.10',
  A: '1',
};

describe('feed reconnect', () => {
  it('backs off with jitter and honors Retry-After', () => {
    expect(backoffDelayMs(1, () => 1)).toBe(1_000);
    expect(backoffDelayMs(2, () => 1)).toBe(2_000);
    expect(backoffDelayMs(3, () => 0.5)).toBe(2_000);
    expect(backoffDelayMs(20, () => 1)).toBe(60_000);
    expect(retryAfterDelayMs(120)).toBe(120_000);
    expect(retryAfterDelayMs(0)).toBe(0);
  });

  it('drops recorded quotes while the link is down and marks the feed disconnected', async () => {
    const received = new Date('2026-11-14T00:00:00.000Z');
    const engine = new MarketDataEngine({ providerId: 'binance-public', priceOrigin: 'VENDOR' }, [
      btc,
    ]);
    const provider = new BinancePublicProvider();
    provider.start((event) => {
      void engine.ingest(event, received);
    });
    provider.markDisconnected();
    await engine.ingest({ kind: 'disconnect' }, received);
    expect(provider.emitRecorded(recorded, received)).toBeNull();
    expect(engine.quote('BTCUSDT', received)).toBeNull();
    expect(engine.health(received).feedState).toBe('DISCONNECTED');
    expect(engine.health(received).liveMarketData).toBe(false);
  });
});
