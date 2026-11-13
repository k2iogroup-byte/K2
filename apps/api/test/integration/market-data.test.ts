import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { Secret, TOTP } from 'otpauth';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { buildApp } from '../../src/app.js';
import { createInitialAdmin } from '../../src/cli/bootstrap-staff.js';
import { loadConfig } from '../../src/config/env.js';
import { apiPackageRoot } from '../../src/config/paths.js';
import { IdentityRepository } from '../../src/infrastructure/db/identity-repository.js';
import { migrateUp } from '../../src/infrastructure/db/migrator.js';
import { PgDatabaseProbe } from '../../src/infrastructure/db/probe.js';
import { createLogger } from '../../src/infrastructure/logging/logger.js';
import { CaptureEmailSender } from '../../src/modules/auth/email.js';
import { MemoryRateLimiter } from '../../src/modules/auth/rate-limit.js';
import { marketDataEngine } from '../../src/modules/market-data/market-data-routes.js';
import { registrationBody } from '../registration.js';
import { validEnv } from '../valid-env.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a database whose name ends with _test');
if (!new URL(databaseUrl).pathname.replace(/^\//, '').endsWith('_test')) {
  throw new Error(
    'Refusing to run integration tests against a database whose name does not end with _test',
  );
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
let baseUrl = '';
let wsUrl = '';
let appClose: (() => Promise<void>) | null = null;
let engine: ReturnType<typeof marketDataEngine> | null = null;

type Jar = Map<string, string>;

beforeAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query('GRANT ALL ON SCHEMA public TO public');
  await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  const config = loadConfig(
    validEnv({
      DATABASE_URL: databaseUrl,
      PORT: '0',
      HOST: '127.0.0.1',
      AUTH_LOGIN_DELAY_BASE_MS: '0',
      AUTH_LOGIN_DELAY_CAP_MS: '0',
      EMAIL_DELIVERY: 'capture',
      MARKET_DATA_MODE: 'disconnected',
    }),
  );
  const app = await buildApp({
    config,
    pool,
    emailSender: new CaptureEmailSender(null),
    limiter: new MemoryRateLimiter(),
    database: new PgDatabaseProbe(pool, createLogger(config)),
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws/market-data`;
  engine = marketDataEngine(app);
  appClose = async () => {
    await app.close();
  };
});

afterAll(async () => {
  if (appClose) await appClose();
  await pool.end();
});

describe('module 04 market data', () => {
  it('exposes feed health only to staff and never claims live prices from a fixture', async () => {
    expect((await call(new Map(), '/internal/market-data/health')).status).toBe(401);
    const trader = await registerTrader();
    expect((await call(trader.jar, '/internal/market-data/health')).status).toBe(403);
    const admin = await staffAdmin();
    const health = await call(admin.jar, '/internal/market-data/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      feedState: 'DISCONNECTED',
      priceOrigin: 'TEST_FIXTURE',
      liveMarketData: false,
      redistributionLicensed: false,
    });
    const forex = await call(admin.jar, '/staff/market-data/instruments', {
      method: 'POST',
      body: {
        market: 'EQUITIES',
        venue: 'FOREX',
        symbol: 'EURUSD',
        providerSymbol: 'eurusd',
        priceScale: 5,
        quantityScale: 0,
      },
    });
    expect(forex.status).toBe(400);
    const created = await call(admin.jar, '/staff/market-data/instruments', {
      method: 'POST',
      body: {
        market: 'EQUITIES',
        venue: 'NASDAQ',
        symbol: 'TEST',
        providerSymbol: 'test',
        priceScale: 2,
        quantityScale: 0,
      },
    });
    expect(created.status).toBe(201);
    const crypto = await call(admin.jar, '/staff/market-data/instruments', {
      method: 'POST',
      body: {
        market: 'CRYPTO',
        venue: 'BINANCE_SPOT',
        symbol: 'BTC-USDT',
        providerSymbol: 'btcusdt',
        priceScale: 2,
        quantityScale: 8,
      },
    });
    expect(crypto.status).toBe(201);

    const received = new Date();
    const active = engine;
    if (!active) throw new Error('engine missing');
    await active.ingest(
      {
        kind: 'quote',
        providerEventId: 'q-1',
        providerSymbol: 'test',
        bid: '10.00',
        ask: '10.25',
        bidSize: '100',
        askSize: '40',
        last: '10.10',
        sourceTimestamp: received.toISOString(),
        sequence: 1,
      },
      received,
    );
    await active.ingest(
      {
        kind: 'quote',
        providerEventId: 'q-1',
        providerSymbol: 'test',
        bid: '99.00',
        ask: '99.25',
        bidSize: '1',
        askSize: '1',
        last: null,
        sourceTimestamp: received.toISOString(),
        sequence: 1,
      },
      received,
    );
    const quote = await call(trader.jar, '/market-data/quotes/TEST');
    expect(quote.status).toBe(200);
    const quoteBody = (await quote.json()) as {
      bid: string;
      liveMarketData: boolean;
      priceOrigin: string;
      feedState: string;
    };
    expect(quoteBody).toMatchObject({
      bid: '10.00',
      ask: '10.25',
      priceOrigin: 'TEST_FIXTURE',
      liveMarketData: false,
      feedState: 'LIVE',
    });
    expect(quoteBody.liveMarketData).toBe(false);

    const tradeAt = new Date(received.getTime() + 1_000);
    await active.ingest(
      {
        kind: 'trade',
        providerEventId: 't-1',
        providerSymbol: 'test',
        price: '10.20',
        quantity: '4',
        sourceTimestamp: tradeAt.toISOString(),
        sequence: 2,
      },
      tradeAt,
    );
    const bars = await call(trader.jar, '/market-data/bars?symbol=TEST&timeframe=1m');
    expect(bars.status).toBe(200);
    const barBody = (await bars.json()) as {
      liveMarketData: boolean;
      priceOrigin: string;
      bars: { close: string; priceOrigin: string; liveMarketData: boolean }[];
    };
    expect(barBody.liveMarketData).toBe(false);
    expect(barBody.priceOrigin).toBe('TEST_FIXTURE');
    expect(barBody.bars[0]).toMatchObject({
      close: '10.2',
      priceOrigin: 'TEST_FIXTURE',
      liveMarketData: false,
    });
    expect((await call(new Map(), '/market-data/quotes/TEST')).status).toBe(401);

    const messages = await socketMessages(trader.jar, async () => {
      await active.ingest(
        {
          kind: 'quote',
          providerEventId: 'q-3',
          providerSymbol: 'btcusdt',
          bid: '100.00',
          ask: '100.50',
          bidSize: '1.5',
          askSize: '2',
          last: null,
          sourceTimestamp: new Date().toISOString(),
          sequence: 1,
        },
        new Date(),
      );
    });
    expect(messages.some((message) => message.liveMarketData === true)).toBe(false);
    expect(
      messages.some((message) => message.type === 'quote' && message.symbol === 'BTC-USDT'),
    ).toBe(true);
    const closed = await new Promise<number>((resolve) => {
      const socket = new WebSocket(wsUrl);
      socket.once('close', (code) => {
        resolve(code);
      });
    });
    expect(closed).toBe(1008);
    const unverified = await registerTrader({ verify: false });
    expect((await call(unverified.jar, '/market-data/quotes/TEST')).status).toBe(403);
    const unverifiedSocket = new WebSocket(wsUrl, {
      headers: {
        cookie: [...unverified.jar.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
      },
    });
    const unverifiedClose = await new Promise<number>((resolve) => {
      unverifiedSocket.once('close', (code) => {
        resolve(code);
      });
    });
    expect(unverifiedClose).toBe(1008);
  });
});

async function socketMessages(
  jar: Jar,
  afterOpen: () => Promise<void>,
): Promise<{ type?: string; symbol?: string; liveMarketData?: boolean }[]> {
  const cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  const socket = new WebSocket(wsUrl, { headers: { cookie } });
  const received: { type?: string; symbol?: string; liveMarketData?: boolean }[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('market data socket timed out'));
    }, 5_000);
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as {
        type?: string;
        symbol?: string;
        liveMarketData?: boolean;
      };
      received.push(message);
      if (message.type === 'subscribed') void afterOpen();
      if (message.type === 'quote') {
        clearTimeout(timer);
        socket.close();
        resolve();
      }
    });
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'subscribe', symbols: ['TEST', 'BTC-USDT'] }));
    });
    socket.on('error', () => {
      clearTimeout(timer);
      reject(new Error('market data socket failed'));
    });
  });
  return received;
}

async function registerTrader(options?: {
  verify?: boolean;
}): Promise<{ jar: Jar; userId: string }> {
  const email = `user-${randomUUID()}@example.com`;
  const jar = new Map<string, string>();
  expect(
    (
      await call(jar, '/auth/register', {
        body: registrationBody(email, 'correct-horse-battery'),
      })
    ).status,
  ).toBe(202);
  expect(
    (await call(jar, '/auth/login', { body: { email, password: 'correct-horse-battery' } })).status,
  ).toBe(200);
  const me = (await (await call(jar, '/users/me')).json()) as { id: string };
  if (options?.verify !== false) {
    await pool.query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [me.id]);
  }
  return { jar, userId: me.id };
}

let cachedAdmin: { jar: Jar; userId: string } | null = null;

async function staffAdmin(): Promise<{ jar: Jar; userId: string }> {
  if (cachedAdmin) return cachedAdmin;
  const email = `admin-${randomUUID()}@example.com`;
  const password = 'administrator-horse-battery';
  const userId = await createInitialAdmin(new IdentityRepository(pool), email, password, {
    ip: null,
    userAgent: 'test',
  });
  const jar = new Map<string, string>();
  expect((await call(jar, '/auth/login', { body: { email, password } })).status).toBe(200);
  const enrolled = await call(jar, '/auth/mfa/enroll', { method: 'POST' });
  const secret = ((await enrolled.json()) as { secret: string }).secret;
  expect(
    (await call(jar, '/auth/mfa/verify', { method: 'POST', body: { code: totp(secret) } })).status,
  ).toBe(200);
  cachedAdmin = { jar, userId };
  return cachedAdmin;
}

function totp(secret: string): string {
  return new TOTP({
    secret: Secret.fromBase32(secret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  }).generate();
}

async function call(
  jar: Jar,
  requestPath: string,
  init?: { method?: string; body?: unknown },
): Promise<Response> {
  const method = init?.method ?? (init?.body === undefined ? 'GET' : 'POST');
  const headers = new Headers();
  if (method !== 'GET' && method !== 'HEAD') headers.set('x-k2-request', '1');
  if (init?.body !== undefined) headers.set('content-type', 'application/json');
  const csrf = jar.get('k2_csrf');
  if (csrf) headers.set('x-csrf-token', csrf);
  const cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  if (cookie) headers.set('cookie', cookie);
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(';');
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const cleared = attrs.some((attr) => {
      const lower = attr.trim().toLowerCase();
      return lower.startsWith('max-age=0') || lower.includes('1970');
    });
    if (cleared) jar.delete(name);
    else jar.set(name, value);
  }
  return response;
}
