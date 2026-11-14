import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../../src/config/env.js';
import {
  RECORDED_FIXTURE_LABEL,
  recordedBookTickerToQuote,
} from '../../src/modules/market-data/binance-public-provider.js';
import { MarketDataEngine } from '../../src/modules/market-data/engine.js';
import { createProvider } from '../../src/modules/market-data/provider.js';
import { validEnv } from '../valid-env.js';

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/binance',
);

const btc = {
  id: '00000000-0000-4000-8000-0000000000b1',
  market: 'CRYPTO' as const,
  venue: 'BINANCE_SPOT' as const,
  symbol: 'BTCUSDT',
  providerSymbol: 'btcusdt',
  priceScale: 2,
  quantityScale: 8,
};

function productionEnv(extra: Record<string, string | undefined> = {}) {
  return validEnv({
    APP_ENV: 'production',
    HOST: '0.0.0.0',
    CORS_ORIGINS: 'https://k2.example.com',
    DATABASE_SSL: 'verify',
    DATABASE_URL: 'postgresql://k2:local-dev-password-value@db.example.com:5432/k2',
    MFA_ENCRYPTION_KEY: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'),
    EMAIL_DELIVERY: 'unconfigured',
    ...extra,
  });
}

describe('binance public provider', () => {
  it('rejects the mode in production and rejects an API key', () => {
    expect(() => loadConfig(productionEnv({ MARKET_DATA_MODE: 'binance-public' }))).toThrow(
      ConfigError,
    );
    expect(() => loadConfig(validEnv({ BINANCE_API_KEY: 'not-a-real-key' }))).toThrow(
      /must not use an API key/,
    );
    expect(() =>
      loadConfig(
        validEnv({
          APP_ENV: 'staging',
          HOST: '0.0.0.0',
          CORS_ORIGINS: 'https://k2-staging.example.com',
          DATABASE_SSL: 'disable',
          DATABASE_URL:
            'postgresql://k2:local-dev-password-value@postgres.railway.internal:5432/railway',
          MFA_ENCRYPTION_KEY: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'),
          EMAIL_DELIVERY: 'unconfigured',
          MARKET_DATA_MODE: 'binance-public',
        }),
      ),
    ).toThrow(/BINANCE_PUBLIC_TESTING/);
  });

  it('maps a recorded bookTicker and does not claim live market data', async () => {
    const raw = JSON.parse(readFileSync(path.join(fixtureDir, 'book-ticker.json'), 'utf8')) as {
      fixture: string;
    };
    expect(raw.fixture).toBe(RECORDED_FIXTURE_LABEL);
    const received = new Date('2026-11-14T00:00:00.000Z');
    const quote = recordedBookTickerToQuote(raw, received);
    expect(quote?.quoteUpdateId).toBe('400900217');
    expect(quote?.askSize).toBe('0.50000000');
    expect(recordedBookTickerToQuote({ u: '1', s: 'BTCUSDT' }, received)).toBeNull();
    const blocked = JSON.parse(readFileSync(path.join(fixtureDir, 'http-451.json'), 'utf8')) as {
      status: number;
    };
    expect(blocked.status).toBe(451);
    expect(recordedBookTickerToQuote(blocked, received)).toBeNull();

    const provider = createProvider('binance-public');
    expect(provider?.priceOrigin).toBe('VENDOR');
    expect(provider?.id).toBe('binance-public');
    const engine = new MarketDataEngine({ providerId: 'binance-public', priceOrigin: 'VENDOR' }, [
      btc,
    ]);
    const event = recordedBookTickerToQuote(raw, received);
    expect(event).not.toBeNull();
    if (event) await engine.ingest(event, received);
    const stored = engine.quote('BTCUSDT', received);
    expect(stored?.quoteUpdateId).toBe('400900217');
    expect(stored?.priceOrigin).toBe('VENDOR');
    expect(engine.health(received).liveMarketData).toBe(false);
    expect(engine.health(received).redistributionLicensed).toBe(false);
  });
});
