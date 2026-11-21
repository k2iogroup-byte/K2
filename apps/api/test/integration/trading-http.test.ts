import { randomUUID } from 'node:crypto';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { apiPackageRoot } from '../../src/config/paths.js';
import { migrateUp } from '../../src/infrastructure/db/migrator.js';
import { PgDatabaseProbe } from '../../src/infrastructure/db/probe.js';
import { createLogger, loggerOptions } from '../../src/infrastructure/logging/logger.js';
import { CaptureEmailSender } from '../../src/modules/auth/email.js';
import { MemoryRateLimiter } from '../../src/modules/auth/rate-limit.js';
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
const sender = new CaptureEmailSender(null);
const limiter = new MemoryRateLimiter();
let baseUrl = '';
let closeApp: () => Promise<void> = () => Promise.resolve();

beforeAll(async () => {
  await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  const config = loadConfig(
    validEnv({
      DATABASE_URL: databaseUrl,
      PORT: '0',
      HOST: '127.0.0.1',
      AUTH_LOGIN_DELAY_BASE_MS: '0',
      AUTH_LOGIN_DELAY_CAP_MS: '0',
      EMAIL_DELIVERY: 'capture',
    }),
  );
  const logger = createLogger(config);
  const app = await buildApp({
    config,
    pool,
    emailSender: sender,
    limiter,
    database: new PgDatabaseProbe(pool, logger),
    logger: {
      ...loggerOptions(config),
      stream: {
        write() {
          return true;
        },
      },
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  closeApp = async () => {
    await app.close();
  };
});

afterAll(async () => {
  await closeApp();
  await pool.end();
});

describe('trading http and socket', () => {
  it('requires a session and an idempotency key, then keeps one reject', async () => {
    const anonymous = await fetch(`${baseUrl}/trading/orders`, { method: 'POST' });
    expect(anonymous.status).toBe(401);
    const email = `trader-${randomUUID()}@example.com`;
    const jar = new Map<string, string>();
    expect((await call(jar, '/auth/register', { body: registrationBody(email) })).status).toBe(202);
    const token = tokenFrom(sender.messages.at(-1)?.text ?? '');
    expect((await call(new Map(), '/auth/email/verify', { body: { token } })).status).toBe(200);
    expect(
      (await call(jar, '/auth/login', { body: { email, password: 'correct-horse-battery' } }))
        .status,
    ).toBe(200);
    const user = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error('user missing');
    const ids = await accountFor(userId);
    const missingKey = await call(jar, '/trading/orders', {
      body: {
        accountId: ids.accountId,
        instrumentId: ids.instrumentId,
        clientOrderId: 'http-1',
        side: 'BUY',
        orderType: 'MARKET',
        quantity: '1',
        limitPrice: null,
      },
    });
    expect(missingKey.status).toBe(400);
    const first = await call(jar, '/trading/orders', {
      headers: { 'idempotency-key': 'idem-http-1' },
      body: {
        accountId: ids.accountId,
        instrumentId: ids.instrumentId,
        clientOrderId: 'http-1',
        side: 'BUY',
        orderType: 'MARKET',
        quantity: '1',
        limitPrice: null,
      },
    });
    expect(first.status).toBe(200);
    const body = (await first.json()) as {
      rejectReason: string;
      liveMarketData: boolean;
      executionVenue: string;
    };
    expect(body).toMatchObject({
      rejectReason: 'CALENDAR_UNCOVERED',
      liveMarketData: false,
      executionVenue: 'K2_SIMULATION',
    });
    const replay = await call(jar, '/trading/orders', {
      headers: { 'idempotency-key': 'idem-http-1' },
      body: {
        accountId: ids.accountId,
        instrumentId: ids.instrumentId,
        clientOrderId: 'http-1',
        side: 'BUY',
        orderType: 'MARKET',
        quantity: '1',
        limitPrice: null,
      },
    });
    expect(await replay.json()).toEqual(body);
    const listed = await call(jar, `/trading/orders?accountId=${ids.accountId}`);
    expect(listed.status).toBe(200);
    const list = (await listed.json()) as { orders: { acceptSequence: string }[] };
    expect(list.orders).toHaveLength(1);
    expect(list.orders[0]?.acceptSequence).toMatch(/^[0-9]+$/);
    const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws/trading`, {
      headers: {
        origin: 'http://127.0.0.1:3000',
        cookie: `k2_session=${jar.get('k2_session') ?? ''}`,
      },
    });
    const message = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('socket timeout'));
      }, 5_000);
      socket.on('message', (data) => {
        clearTimeout(timer);
        resolve(String(data));
      });
    });
    socket.close();
    expect(JSON.parse(message)).toMatchObject({
      sequence: '0',
      liveMarketData: false,
      executionVenue: 'K2_SIMULATION',
    });
  });
});

async function accountFor(userId: string): Promise<{ accountId: string; instrumentId: string }> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const size = (21000 + (Number.parseInt(suffix.slice(0, 4), 16) % 500000)).toFixed(4);
    const product = await client.query<{ id: string }>(
      `INSERT INTO challenge_products (account_size, currency, active) VALUES ($1, 'USD', true) RETURNING id`,
      [size],
    );
    const productId = product.rows[0]?.id;
    const price = await client.query<{ id: string }>(
      `INSERT INTO product_price_versions (product_id, price, currency, valid_from, decision_ref)
       VALUES ($1, 100, 'USD', now(), $2) RETURNING id`,
      [productId, `HP-${suffix}`],
    );
    const rules = await client.query<{ id: string }>(
      `INSERT INTO rule_sets (code, account_type) VALUES ($1, 'CHALLENGE') RETURNING id`,
      [`HTTP_${suffix}`.slice(0, 32).toUpperCase()],
    );
    const version = await client.query<{ id: string }>(
      `INSERT INTO rule_set_versions (rule_set_id, version_number, decision_ref, published_at)
       VALUES ($1, 1, $2, now()) RETURNING id`,
      [rules.rows[0]?.id, `HR-${suffix}`],
    );
    const evidence = await client.query<{ id: string }>(
      `INSERT INTO purchase_evidence_references (
         source_system, idempotency_key, external_reference, user_id, price_version_id, amount, currency, verified_at
       ) VALUES ('M-08', $1, $2, $3, $4, 100, 'USD', now()) RETURNING id`,
      [`http-${suffix}`, `ext-${suffix}`, userId, price.rows[0]?.id],
    );
    const account = await client.query<{ id: string }>(
      `INSERT INTO trading_accounts (
         user_id, account_type, stage, state, initial_capital, currency, product_id,
         price_version_id, rule_set_version_id, purchase_evidence_id, provisioned_at
       ) VALUES ($1, 'CHALLENGE', 'STAGE_1', 'PROVISIONED', 10000, 'USD', $2, $3, $4, $5, now())
       RETURNING id`,
      [userId, productId, price.rows[0]?.id, version.rows[0]?.id, evidence.rows[0]?.id],
    );
    const accountId = account.rows[0]?.id;
    await client.query(
      `INSERT INTO account_state_transitions (
         account_id, from_state, to_state, reason_code, reason, actor_type, idempotency_key
       ) VALUES ($1, 'PROVISIONED', 'ACTIVE', 'SYSTEM_ACTIVATE', 'test activation for trading', 'SYSTEM', $2)`,
      [accountId, `http-act-${suffix}`],
    );
    await client.query(`UPDATE trading_accounts SET state = 'ACTIVE' WHERE id = $1`, [accountId]);
    const symbol = `HT${suffix}`.slice(0, 16).toUpperCase();
    const instrument = await client.query<{ id: string }>(
      `INSERT INTO instruments (
         market, venue, symbol, provider_symbol, price_scale, quantity_scale, trading_status, quote_asset
       ) VALUES ('EQUITIES', 'NASDAQ', $1, $2, 2, 8, 'TRADABLE', 'USD') RETURNING id`,
      [symbol, symbol.toLowerCase()],
    );
    await client.query('COMMIT');
    return { accountId: accountId ?? '', instrumentId: instrument.rows[0]?.id ?? '' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function tokenFrom(text: string): string {
  const match = /#([A-Za-z0-9_-]{43})/.exec(text);
  if (!match?.[1]) throw new Error('Email did not contain a token');
  return match[1];
}

async function call(
  jar: Map<string, string>,
  path: string,
  init?: { body?: unknown; headers?: Record<string, string> },
): Promise<Response> {
  const method = init?.body === undefined ? 'GET' : 'POST';
  const headers = new Headers(init?.headers);
  if (method === 'POST') headers.set('x-k2-request', '1');
  if (init?.body !== undefined) headers.set('content-type', 'application/json');
  const csrf = jar.get('k2_csrf');
  if (csrf) headers.set('x-csrf-token', csrf);
  const cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  if (cookie) headers.set('cookie', cookie);
  const response = await fetch(`${baseUrl}${path}`, {
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
    const cleared = attrs.some((attr) => attr.trim().toLowerCase().startsWith('max-age=0'));
    if (cleared) jar.delete(name);
    else jar.set(name, value);
  }
  return response;
}
