import { randomUUID } from 'node:crypto';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
let baseUrl = '';
let closeApp: () => Promise<void> = () => Promise.resolve();

beforeAll(async () => {
  await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  const config = loadConfig(
    validEnv({
      DATABASE_URL: databaseUrl,
      PORT: '0',
      HOST: '127.0.0.1',
      EXECUTION_ENABLED: 'true',
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
    limiter: new MemoryRateLimiter(),
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

describe('server risk composition', () => {
  it('approves a buy inside the limits and rejects a buy through the floor', async () => {
    const email = `risk-boot-${randomUUID()}@example.com`;
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
    const instrumentId = await cryptoInstrument();
    const healthy = await activeAccount(userId, '10000.0000');
    const breached = await activeAccount(userId, '1000.0000');
    const stamp = randomUUID();
    const approved = await order(jar, healthy, instrumentId, `boot-ok-${stamp}`);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ state: 'OPEN', rejectReason: null });
    const approvedRow = await pool.query<{ decision: string; reason_code: string }>(
      `SELECT decision, reason_code FROM risk_decisions
       WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [healthy],
    );
    expect(approvedRow.rows[0]).toEqual({ decision: 'APPROVE', reason_code: 'RISK_OK' });
    const rejected = await order(jar, breached, instrumentId, `boot-floor-${stamp}`);
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({
      state: 'REJECTED',
      rejectReason: 'MAX_DRAWDOWN',
    });
  });
});

async function order(
  jar: Map<string, string>,
  accountId: string,
  instrumentId: string,
  key: string,
): Promise<Response> {
  return call(jar, '/trading/orders', {
    headers: { 'idempotency-key': key },
    body: {
      accountId,
      instrumentId,
      clientOrderId: key,
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: '1',
      limitPrice: '9.00',
    },
  });
}

async function cryptoInstrument(): Promise<string> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const symbol = `RSK${suffix}`.toUpperCase();
  const instrument = await pool.query<{ id: string }>(
    `INSERT INTO instruments (
       market, venue, symbol, provider_symbol, price_scale, quantity_scale, trading_status, quote_asset
     ) VALUES ('CRYPTO', 'BINANCE_SPOT', $1, $2, 2, 8, 'TRADABLE', 'USDT')
     RETURNING id`,
    [symbol, symbol.toLowerCase()],
  );
  const instrumentId = instrument.rows[0]?.id;
  if (!instrumentId) throw new Error('instrument missing');
  await pool.query(
    `INSERT INTO quote_snapshots (
       instrument_id, bid, ask, bid_size, ask_size, source_timestamp, received_timestamp,
       processed_timestamp, sequence_no, provider_event_id, price_origin, feed_state
     ) VALUES ($1, 10, 12, 5, 5, now(), now(), now(), 80, '80', 'TEST_FIXTURE', 'LIVE')`,
    [instrumentId],
  );
  return instrumentId;
}

async function activeAccount(userId: string, cash: string): Promise<string> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const size = (31000 + (Number.parseInt(suffix.slice(0, 4), 16) % 400000)).toFixed(4);
    const product = await client.query<{ id: string }>(
      `INSERT INTO challenge_products (account_size, currency, active) VALUES ($1, 'USD', true) RETURNING id`,
      [size],
    );
    const price = await client.query<{ id: string }>(
      `INSERT INTO product_price_versions (product_id, price, currency, valid_from, decision_ref)
       VALUES ($1, 100, 'USD', now(), $2) RETURNING id`,
      [product.rows[0]?.id, `SR-${suffix}`],
    );
    const rules = await client.query<{ id: string }>(
      `INSERT INTO rule_sets (code, account_type) VALUES ($1, 'CHALLENGE') RETURNING id`,
      [`SRV_${suffix}`.slice(0, 32).toUpperCase()],
    );
    const version = await client.query<{ id: string }>(
      `INSERT INTO rule_set_versions (rule_set_id, version_number, decision_ref, published_at)
       VALUES ($1, 1, $2, now()) RETURNING id`,
      [rules.rows[0]?.id, `SV-${suffix}`],
    );
    const evidence = await client.query<{ id: string }>(
      `INSERT INTO purchase_evidence_references (
         source_system, idempotency_key, external_reference, user_id, price_version_id,
         amount, currency, verified_at
       ) VALUES ('M-08', $1, $2, $3, $4, 100, 'USD', now()) RETURNING id`,
      [`srv-${suffix}`, `srv-ext-${suffix}`, userId, price.rows[0]?.id],
    );
    const account = await client.query<{ id: string }>(
      `INSERT INTO trading_accounts (
         user_id, account_type, stage, state, initial_capital, currency, product_id,
         price_version_id, rule_set_version_id, purchase_evidence_id, provisioned_at
       ) VALUES ($1, 'CHALLENGE', 'STAGE_1', 'PROVISIONED', 10000, 'USD', $2, $3, $4, $5, now())
       RETURNING id`,
      [userId, product.rows[0]?.id, price.rows[0]?.id, version.rows[0]?.id, evidence.rows[0]?.id],
    );
    const accountId = account.rows[0]?.id;
    if (!accountId) throw new Error('account missing');
    await client.query(
      `INSERT INTO account_state_transitions (
         account_id, from_state, to_state, reason_code, reason, actor_type, idempotency_key
       ) VALUES ($1, 'PROVISIONED', 'ACTIVE', 'SYSTEM_ACTIVATE', 'sandbox activation', 'SYSTEM', $2)`,
      [accountId, `srv-act-${suffix}`],
    );
    await client.query(`UPDATE trading_accounts SET state = 'ACTIVE' WHERE id = $1`, [accountId]);
    await client.query(
      `INSERT INTO simulation_cash_projections (account_id, cash) VALUES ($1, $2)`,
      [accountId, cash],
    );
    await client.query('COMMIT');
    return accountId;
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
