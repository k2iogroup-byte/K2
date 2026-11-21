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
import { Phase2Orders } from '../../src/modules/trading/phase2-orders.js';
import {
  assertEntryProtection,
  attachFilledProtection,
  saveEntryProtection,
} from '../../src/modules/trading/protection.js';
import type {
  RiskAuthorizer,
  RiskDecision,
  SessionCalendar,
} from '../../src/modules/trading/risk-authorizer.js';
import type { ExecutableQuote } from '../../src/modules/trading/trading-service.js';
import { TradingConflictError, TradingService } from '../../src/modules/trading/trading-service.js';
import { registrationBody } from '../registration.js';
import { validEnv } from '../valid-env.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a database whose name ends with _test');

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

class ApprovingRiskAuthorizer implements RiskAuthorizer {
  authorize(): Promise<RiskDecision> {
    return Promise.resolve({
      decision: 'APPROVE',
      decisionId: randomUUID(),
      reasonCode: 'TEST_APPROVED',
      mode: 'TEST_DOUBLE',
    });
  }
}

class OpenEquityCalendar implements SessionCalendar {
  equitySessionOpen(): boolean {
    return true;
  }
}

function quote(bid: string, ask: string, updateId: string): ExecutableQuote {
  return {
    quoteUpdateId: updateId,
    bid,
    ask,
    bidSize: '5.00000000',
    askSize: '5.00000000',
    receivedAt: new Date('2026-11-21T16:00:00.000Z'),
    feedState: 'LIVE',
    priceOrigin: 'TEST_FIXTURE',
  };
}

describe('stop loss and take profit', () => {
  beforeAll(async () => {
    await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  });

  it('attaches protection, keeps it after a partial sell, and lets the stop close the rest', async () => {
    const ids = await makeAccount('sl');
    const trading = service();
    const phase2 = new Phase2Orders(pool, trading, null, true);
    await saveEntryProtection(pool, {
      accountId: ids.accountId,
      userId: ids.userId,
      instrumentId: ids.instrumentId,
      clientOrderId: 'entry-1',
      stopLoss: '9.00',
      takeProfit: '12.00',
    });
    const bought = await trading.submit({
      accountId: ids.accountId,
      userId: ids.userId,
      instrumentId: ids.instrumentId,
      clientOrderId: 'entry-1',
      idempotencyKey: `buy-${ids.accountId}`,
      side: 'BUY',
      orderType: 'MARKET',
      quantity: '2',
      limitPrice: null,
      quote: quote('9.50', '10.00', '1'),
    });
    expect(bought.state).toBe('FILLED');
    await attachFilledProtection(pool, ids.accountId, ids.instrumentId);
    const protection = await pool.query<{ stop_loss_price: string; take_profit_price: string }>(
      `SELECT stop_loss_price::text, take_profit_price::text
         FROM position_protection
         JOIN positions ON positions.id = position_protection.position_id
        WHERE positions.account_id = $1`,
      [ids.accountId],
    );
    expect(protection.rows[0]?.stop_loss_price.startsWith('9')).toBe(true);
    expect(protection.rows[0]?.take_profit_price.startsWith('12')).toBe(true);

    const sold = await trading.submit({
      accountId: ids.accountId,
      userId: ids.userId,
      instrumentId: ids.instrumentId,
      clientOrderId: 'partial-1',
      idempotencyKey: `sell-${ids.accountId}`,
      side: 'SELL',
      orderType: 'MARKET',
      quantity: '1',
      limitPrice: null,
      quote: quote('9.50', '10.00', '2'),
    });
    expect(sold.state).toBe('FILLED');
    const still = await pool.query<{ quantity: string }>(
      `SELECT quantity::text FROM positions WHERE account_id = $1`,
      [ids.accountId],
    );
    expect(still.rows[0]?.quantity).toBe('1.00000000');
    expect(protection.rows).toHaveLength(1);

    await phase2.onQuote(ids.instrumentId, quote('9.00', '9.20', '3'));
    const closed = await pool.query<{ quantity: string; status: string }>(
      `SELECT quantity::text, status FROM positions WHERE account_id = $1`,
      [ids.accountId],
    );
    expect(closed.rows[0]).toMatchObject({ quantity: '0.00000000', status: 'CLOSED' });
    const sells = await pool.query<{ quantity: string }>(
      `SELECT executions.quantity::text
         FROM executions
         JOIN orders ON orders.id = executions.order_id
        WHERE executions.account_id = $1 AND orders.side = 'SELL'`,
      [ids.accountId],
    );
    const soldQty = sells.rows.reduce((sum, row) => sum + Number(row.quantity), 0);
    expect(soldQty).toBe(2);
    const take = await pool.query<{ state: string }>(
      `SELECT state FROM conditional_orders
        WHERE account_id = $1 AND kind = 'TAKE_PROFIT'`,
      [ids.accountId],
    );
    expect(take.rows[0]?.state).toBe('CANCELLED');
  });

  it('closes the whole position when take profit is reached', async () => {
    const ids = await makeAccount('tp');
    const trading = service();
    await saveEntryProtection(pool, {
      accountId: ids.accountId,
      userId: ids.userId,
      instrumentId: ids.instrumentId,
      clientOrderId: 'entry-tp',
      stopLoss: '8.00',
      takeProfit: '11.00',
    });
    await trading.submit({
      accountId: ids.accountId,
      userId: ids.userId,
      instrumentId: ids.instrumentId,
      clientOrderId: 'entry-tp',
      idempotencyKey: `buy-tp-${ids.accountId}`,
      side: 'BUY',
      orderType: 'MARKET',
      quantity: '1',
      limitPrice: null,
      quote: quote('9.50', '10.00', '1'),
    });
    await attachFilledProtection(pool, ids.accountId, ids.instrumentId);
    const phase2 = new Phase2Orders(pool, trading, null, true);
    await phase2.onQuote(ids.instrumentId, quote('11.00', '11.20', '2'));
    const closed = await pool.query<{ quantity: string }>(
      `SELECT quantity::text FROM positions WHERE account_id = $1`,
      [ids.accountId],
    );
    expect(closed.rows[0]?.quantity).toBe('0.00000000');
    const stop = await pool.query<{ state: string }>(
      `SELECT state FROM conditional_orders WHERE account_id = $1 AND kind = 'STOP_LOSS'`,
      [ids.accountId],
    );
    expect(stop.rows[0]?.state).toBe('CANCELLED');
  });

  it('rejects a stop that is not below the entry reference and a reused stop key', async () => {
    const ids = await makeAccount('bad');
    await expect(
      assertEntryProtection(pool, ids.instrumentId, '10.00', '11.00', '10.00'),
    ).rejects.toMatchObject({ code: 'PROTECTION_PRICE_INVALID' });
    const phase2 = new Phase2Orders(pool, service(), null, true);
    await phase2.placeStop({
      accountId: ids.accountId,
      userId: ids.userId,
      instrumentId: ids.instrumentId,
      clientOrderId: 'stop-a',
      idempotencyKey: `same-${ids.accountId}`,
      quantity: '1',
      triggerPrice: '10.00',
      quote: null,
    });
    await expect(
      phase2.placeStop({
        accountId: ids.accountId,
        userId: ids.userId,
        instrumentId: ids.instrumentId,
        clientOrderId: 'stop-b',
        idempotencyKey: `same-${ids.accountId}`,
        quantity: '2',
        triggerPrice: '11.00',
        quote: null,
      }),
    ).rejects.toBeInstanceOf(TradingConflictError);
  });
});

describe('protection http ownership', () => {
  const sender = new CaptureEmailSender(null);
  let baseUrl = '';
  let closeApp: () => Promise<void> = () => Promise.resolve();

  beforeAll(async () => {
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
  });

  it('returns 404 for another user and rejects a bad or stale protection price', async () => {
    const owner = await signIn('owner');
    const other = await signIn('other');
    const positionId = await openPosition(owner.accountId, owner.instrumentId);
    const foreignOrder = await call(other.jar, `/trading/orders/${randomUUID()}`);
    expect(foreignOrder.status).toBe(404);
    const foreignPosition = await call(other.jar, `/trading/positions/${positionId}`, {
      method: 'PATCH',
      headers: { 'idempotency-key': `prot-foreign-${positionId}` },
      body: { version: 0, stopLossPrice: '9.00', takeProfitPrice: '12.00' },
    });
    expect(foreignPosition.status).toBe(404);

    const invalid = await call(owner.jar, `/trading/positions/${positionId}`, {
      method: 'PATCH',
      headers: { 'idempotency-key': `prot-bad-${positionId}` },
      body: { version: 0, stopLossPrice: '11.00', takeProfitPrice: '12.00' },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: 'PROTECTION_PRICE_INVALID' } });

    const first = await call(owner.jar, `/trading/positions/${positionId}`, {
      method: 'PATCH',
      headers: { 'idempotency-key': `prot-ok-${positionId}` },
      body: { version: 0, stopLossPrice: '9.00', takeProfitPrice: '12.00' },
    });
    expect(first.status).toBe(200);
    const saved = (await first.json()) as { version: number; stopLossPrice: string };
    expect(saved.version).toBe(1);
    expect(saved.stopLossPrice.startsWith('9')).toBe(true);
    const replay = await call(owner.jar, `/trading/positions/${positionId}`, {
      method: 'PATCH',
      headers: { 'idempotency-key': `prot-ok-${positionId}` },
      body: { version: 0, stopLossPrice: '9.00', takeProfitPrice: '12.00' },
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ version: 1 });
    const conflict = await call(owner.jar, `/trading/positions/${positionId}`, {
      method: 'PATCH',
      headers: { 'idempotency-key': `prot-ok-${positionId}` },
      body: { version: 0, stopLossPrice: '8.00', takeProfitPrice: '12.00' },
    });
    expect(conflict.status).toBe(409);
    const stale = await call(owner.jar, `/trading/positions/${positionId}`, {
      method: 'PATCH',
      headers: { 'idempotency-key': `prot-stale-${positionId}` },
      body: { version: 0, stopLossPrice: '8.50', takeProfitPrice: '12.00' },
    });
    expect(stale.status).toBe(409);
  });

  async function signIn(label: string): Promise<{
    jar: Map<string, string>;
    userId: string;
    accountId: string;
    instrumentId: string;
  }> {
    const email = `${label}-${randomUUID()}@example.com`;
    const jar = new Map<string, string>();
    expect((await call(jar, '/auth/register', { body: registrationBody(email) })).status).toBe(202);
    const token = /#([A-Za-z0-9_-]{43})/.exec(sender.messages.at(-1)?.text ?? '')?.[1];
    if (!token) throw new Error('missing token');
    expect((await call(new Map(), '/auth/email/verify', { body: { token } })).status).toBe(200);
    expect(
      (await call(jar, '/auth/login', { body: { email, password: 'correct-horse-battery' } }))
        .status,
    ).toBe(200);
    const user = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    const userId = user.rows[0]?.id ?? '';
    const ids = await makeAccount(label, userId);
    return { jar, userId, accountId: ids.accountId, instrumentId: ids.instrumentId };
  }

  async function call(
    jar: Map<string, string>,
    target: string,
    init?: { method?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<Response> {
    const method = init?.method ?? (init?.body === undefined ? 'GET' : 'POST');
    const headers = new Headers(init?.headers);
    if (method !== 'GET') headers.set('x-k2-request', '1');
    if (init?.body !== undefined) headers.set('content-type', 'application/json');
    const csrf = jar.get('k2_csrf');
    if (csrf) headers.set('x-csrf-token', csrf);
    const cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    if (cookie) headers.set('cookie', cookie);
    const response = await fetch(`${baseUrl}${target}`, {
      method,
      headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const split = pair?.split('=');
      if (split?.[0] && split[1]) jar.set(split[0], split.slice(1).join('='));
    }
    return response;
  }
});

function service(): TradingService {
  return new TradingService(pool, {
    authorizer: new ApprovingRiskAuthorizer(),
    calendar: new OpenEquityCalendar(),
    fillsEnabled: true,
  });
}

async function openPosition(accountId: string, instrumentId: string): Promise<string> {
  const position = await pool.query<{ id: string }>(
    `INSERT INTO positions (account_id, instrument_id, status, quantity, average_entry, opened_at)
     VALUES ($1, $2, 'OPEN', 1, 10, now()) RETURNING id`,
    [accountId, instrumentId],
  );
  await pool.query(
    `INSERT INTO quote_snapshots (
       instrument_id, bid, ask, bid_size, ask_size, source_timestamp, received_timestamp,
       processed_timestamp, sequence_no, provider_event_id, price_origin, feed_state
     ) VALUES ($1, 10, 10.1, 5, 5, now(), now(), now(), 1, '1', 'TEST_FIXTURE', 'LIVE')`,
    [instrumentId],
  );
  return position.rows[0]?.id ?? '';
}

afterAll(async () => {
  await pool.end();
});

async function makeAccount(
  label: string,
  existingUserId?: string,
): Promise<{ userId: string; accountId: string; instrumentId: string }> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let userId = existingUserId ?? '';
    if (!userId) {
      const user = await client.query<{ id: string }>(
        'INSERT INTO users (email) VALUES ($1) RETURNING id',
        [`${label}-${suffix}@example.com`],
      );
      userId = user.rows[0]?.id ?? '';
    }
    const size = (41000 + (Number.parseInt(suffix.slice(0, 4), 16) % 400000)).toFixed(4);
    const product = await client.query<{ id: string }>(
      `INSERT INTO challenge_products (account_size, currency, active) VALUES ($1, 'USD', true) RETURNING id`,
      [size],
    );
    const price = await client.query<{ id: string }>(
      `INSERT INTO product_price_versions (product_id, price, currency, valid_from, decision_ref)
       VALUES ($1, 100, 'USD', now(), $2) RETURNING id`,
      [product.rows[0]?.id, `PP-${suffix}`],
    );
    const rules = await client.query<{ id: string }>(
      `INSERT INTO rule_sets (code, account_type) VALUES ($1, 'CHALLENGE') RETURNING id`,
      [`P2_${suffix}`.slice(0, 32).toUpperCase()],
    );
    const version = await client.query<{ id: string }>(
      `INSERT INTO rule_set_versions (rule_set_id, version_number, decision_ref, published_at)
       VALUES ($1, 1, $2, now()) RETURNING id`,
      [rules.rows[0]?.id, `PR-${suffix}`],
    );
    await client.query(
      `INSERT INTO commission_market_scopes (rule_set_version_id, market, decision_ref)
       VALUES ($1, 'EQUITIES', $2)`,
      [version.rows[0]?.id, `PC-${suffix}`],
    );
    const evidence = await client.query<{ id: string }>(
      `INSERT INTO purchase_evidence_references (
         source_system, idempotency_key, external_reference, user_id, price_version_id, amount, currency, verified_at
       ) VALUES ('M-08', $1, $2, $3, $4, 100, 'USD', now()) RETURNING id`,
      [`pp-${suffix}`, `px-${suffix}`, userId, price.rows[0]?.id],
    );
    const account = await client.query<{ id: string }>(
      `INSERT INTO trading_accounts (
         user_id, account_type, stage, state, initial_capital, currency, product_id,
         price_version_id, rule_set_version_id, purchase_evidence_id, provisioned_at
       ) VALUES ($1, 'CHALLENGE', 'STAGE_1', 'PROVISIONED', 10000, 'USD', $2, $3, $4, $5, now())
       RETURNING id`,
      [userId, product.rows[0]?.id, price.rows[0]?.id, version.rows[0]?.id, evidence.rows[0]?.id],
    );
    const accountId = account.rows[0]?.id ?? '';
    await client.query(
      `INSERT INTO account_state_transitions (
         account_id, from_state, to_state, reason_code, reason, actor_type, idempotency_key
       ) VALUES ($1, 'PROVISIONED', 'ACTIVE', 'SYSTEM_ACTIVATE', 'test activation for trading', 'SYSTEM', $2)`,
      [accountId, `pp-act-${suffix}`],
    );
    await client.query(`UPDATE trading_accounts SET state = 'ACTIVE' WHERE id = $1`, [accountId]);
    const symbol = `P${suffix}`.slice(0, 16).toUpperCase();
    const instrument = await client.query<{ id: string }>(
      `INSERT INTO instruments (
         market, venue, symbol, provider_symbol, price_scale, quantity_scale, trading_status, quote_asset
       ) VALUES ('EQUITIES', 'NASDAQ', $1, $2, 2, 8, 'TRADABLE', 'USD') RETURNING id`,
      [symbol, symbol.toLowerCase()],
    );
    await client.query('COMMIT');
    return { userId, accountId, instrumentId: instrument.rows[0]?.id ?? '' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
