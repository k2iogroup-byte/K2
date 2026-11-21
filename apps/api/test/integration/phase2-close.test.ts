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
import { closeByPercent } from '../../src/modules/trading/close-position.js';
import { Phase2Orders } from '../../src/modules/trading/phase2-orders.js';
import {
  attachFilledProtection,
  protectionHash,
  saveEntryProtection,
} from '../../src/modules/trading/protection.js';
import type {
  RiskAuthorizer,
  RiskDecision,
  SessionCalendar,
} from '../../src/modules/trading/risk-authorizer.js';
import type { ExecutableQuote } from '../../src/modules/trading/trading-service.js';
import { TradingService } from '../../src/modules/trading/trading-service.js';
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

function quote(updateId: string): ExecutableQuote {
  return {
    quoteUpdateId: updateId,
    bid: '10.00',
    ask: '10.10',
    bidSize: '8.00000000',
    askSize: '8.00000000',
    receivedAt: new Date('2026-11-21T16:00:00.000Z'),
    feedState: 'LIVE',
    priceOrigin: 'TEST_FIXTURE',
  };
}

describe('close by percentage', () => {
  beforeAll(async () => {
    await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  });

  it('sells 25, 50, 75 and 100 percent, flooring dust to a 400', async () => {
    const ids = await makeAccount('pct');
    const trading = service();
    await trading.submit({
      accountId: ids.accountId,
      userId: ids.userId,
      instrumentId: ids.instrumentId,
      clientOrderId: 'open-4',
      idempotencyKey: `open-${ids.accountId}`,
      side: 'BUY',
      orderType: 'MARKET',
      quantity: '4',
      limitPrice: null,
      quote: quote('1'),
    });
    const positionId = await positionOf(ids.accountId);
    const sold: string[] = [];
    for (const percentage of [25, 50, 75, 100] as const) {
      const result = await closeByPercent(pool, trading, {
        positionId,
        userId: ids.userId,
        percentage,
        idempotencyKey: `close-${percentage}-${ids.accountId}`,
        requestHash: protectionHash({ positionId, percentage }),
        quote: quote(String(percentage / 25 + 1)),
      });
      expect(result.state).toBe('FILLED');
      sold.push(result.filledQuantity);
    }
    expect(sold).toEqual(['1.00000000', '1.50000000', '1.12500000', '0.37500000']);
    const closed = await pool.query<{ quantity: string }>(
      'SELECT quantity::text FROM positions WHERE id = $1',
      [positionId],
    );
    expect(closed.rows[0]?.quantity).toBe('0.00000000');

    const dust = await makeAccount('dust');
    const dustPosition = await pool.query<{ id: string }>(
      `INSERT INTO positions (account_id, instrument_id, status, quantity, average_entry, opened_at)
       VALUES ($1, $2, 'OPEN', 0.00000001, 10, now()) RETURNING id`,
      [dust.accountId, dust.instrumentId],
    );
    await expect(
      closeByPercent(pool, trading, {
        positionId: dustPosition.rows[0]?.id ?? '',
        userId: dust.userId,
        percentage: 25,
        idempotencyKey: `dust-${dust.accountId}`,
        requestHash: protectionHash({ positionId: dustPosition.rows[0]?.id, percentage: 25 }),
        quote: quote('9'),
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    const unchanged = await pool.query<{ quantity: string }>(
      'SELECT quantity::text FROM positions WHERE id = $1',
      [dustPosition.rows[0]?.id],
    );
    expect(unchanged.rows[0]?.quantity).toBe('0.00000001');
    await expect(
      closeByPercent(pool, trading, {
        positionId,
        userId: randomUUID(),
        percentage: 100,
        idempotencyKey: `foreign-${ids.accountId}`,
        requestHash: protectionHash({ positionId, percentage: 100 }),
        quote: quote('8'),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('does not oversell when a full close and a stop loss run together', async () => {
    const ids = await makeAccount('race');
    const trading = service();
    const phase2 = new Phase2Orders(pool, trading, null, true);
    await saveEntryProtection(pool, {
      accountId: ids.accountId,
      userId: ids.userId,
      instrumentId: ids.instrumentId,
      clientOrderId: 'race-entry',
      stopLoss: '10.00',
      takeProfit: '12.00',
    });
    await trading.submit({
      accountId: ids.accountId,
      userId: ids.userId,
      instrumentId: ids.instrumentId,
      clientOrderId: 'race-entry',
      idempotencyKey: `race-buy-${ids.accountId}`,
      side: 'BUY',
      orderType: 'MARKET',
      quantity: '2',
      limitPrice: null,
      quote: quote('1'),
    });
    await attachFilledProtection(pool, ids.accountId, ids.instrumentId);
    const positionId = await positionOf(ids.accountId);
    await Promise.all([
      closeByPercent(pool, trading, {
        positionId,
        userId: ids.userId,
        percentage: 100,
        idempotencyKey: `race-close-${ids.accountId}`,
        requestHash: protectionHash({ positionId, percentage: 100 }),
        quote: quote('2'),
      }),
      phase2.onQuote(ids.instrumentId, quote('3')),
    ]);
    const position = await pool.query<{ quantity: string; reserved_sell: string }>(
      'SELECT quantity::text, reserved_sell::text FROM positions WHERE id = $1',
      [positionId],
    );
    expect(position.rows[0]).toMatchObject({ quantity: '0.00000000', reserved_sell: '0.00000000' });
    const sells = await pool.query<{ quantity: string }>(
      `SELECT executions.quantity::text
         FROM executions JOIN orders ON orders.id = executions.order_id
        WHERE executions.account_id = $1 AND orders.side = 'SELL'`,
      [ids.accountId],
    );
    const total = sells.rows.reduce((sum, row) => sum + Number(row.quantity), 0);
    expect(total).toBe(2);
  });
});

describe('close http', () => {
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
        stream: { write: () => true },
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

  it('rejects a percentage outside 25, 50, 75 and 100, and hides another user', async () => {
    const owner = await signIn('close-owner');
    const other = await signIn('close-other');
    const position = await pool.query<{ id: string }>(
      `INSERT INTO positions (account_id, instrument_id, status, quantity, average_entry, opened_at)
       VALUES ($1, $2, 'OPEN', 2, 10, now()) RETURNING id`,
      [owner.accountId, owner.instrumentId],
    );
    const positionId = position.rows[0]?.id ?? '';
    const bad = await call(owner.jar, `/trading/positions/${positionId}/close`, {
      headers: { 'idempotency-key': `bad-pct-${positionId}` },
      body: { percentage: 40 },
    });
    expect(bad.status).toBe(400);
    const hidden = await call(other.jar, `/trading/positions/${positionId}/close`, {
      headers: { 'idempotency-key': `hide-${positionId}` },
      body: { percentage: 50 },
    });
    expect(hidden.status).toBe(404);
    const still = await pool.query<{ quantity: string }>(
      'SELECT quantity::text FROM positions WHERE id = $1',
      [positionId],
    );
    expect(still.rows[0]?.quantity).toBe('2.00000000');
  });

  async function signIn(label: string): Promise<{
    jar: Map<string, string>;
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
    const ids = await makeAccount(label, user.rows[0]?.id);
    return { jar, accountId: ids.accountId, instrumentId: ids.instrumentId };
  }

  async function call(
    jar: Map<string, string>,
    target: string,
    init?: { body?: unknown; headers?: Record<string, string> },
  ): Promise<Response> {
    const method = init?.body === undefined ? 'GET' : 'POST';
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

afterAll(async () => {
  await pool.end();
});

function service(): TradingService {
  return new TradingService(pool, {
    authorizer: new ApprovingRiskAuthorizer(),
    calendar: new OpenEquityCalendar(),
    fillsEnabled: true,
  });
}

async function positionOf(accountId: string): Promise<string> {
  const row = await pool.query<{ id: string }>('SELECT id FROM positions WHERE account_id = $1', [
    accountId,
  ]);
  return row.rows[0]?.id ?? '';
}

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
    const size = (42000 + (Number.parseInt(suffix.slice(0, 4), 16) % 400000)).toFixed(4);
    const product = await client.query<{ id: string }>(
      `INSERT INTO challenge_products (account_size, currency, active) VALUES ($1, 'USD', true) RETURNING id`,
      [size],
    );
    const price = await client.query<{ id: string }>(
      `INSERT INTO product_price_versions (product_id, price, currency, valid_from, decision_ref)
       VALUES ($1, 100, 'USD', now(), $2) RETURNING id`,
      [product.rows[0]?.id, `CP-${suffix}`],
    );
    const rules = await client.query<{ id: string }>(
      `INSERT INTO rule_sets (code, account_type) VALUES ($1, 'CHALLENGE') RETURNING id`,
      [`CL_${suffix}`.slice(0, 32).toUpperCase()],
    );
    const version = await client.query<{ id: string }>(
      `INSERT INTO rule_set_versions (rule_set_id, version_number, decision_ref, published_at)
       VALUES ($1, 1, $2, now()) RETURNING id`,
      [rules.rows[0]?.id, `CR-${suffix}`],
    );
    await client.query(
      `INSERT INTO commission_market_scopes (rule_set_version_id, market, decision_ref)
       VALUES ($1, 'EQUITIES', $2)`,
      [version.rows[0]?.id, `CC-${suffix}`],
    );
    const evidence = await client.query<{ id: string }>(
      `INSERT INTO purchase_evidence_references (
         source_system, idempotency_key, external_reference, user_id, price_version_id, amount, currency, verified_at
       ) VALUES ('M-08', $1, $2, $3, $4, 100, 'USD', now()) RETURNING id`,
      [`cp-${suffix}`, `cx-${suffix}`, userId, price.rows[0]?.id],
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
      [accountId, `cp-act-${suffix}`],
    );
    await client.query(`UPDATE trading_accounts SET state = 'ACTIVE' WHERE id = $1`, [accountId]);
    const symbol = `C${suffix}`.slice(0, 16).toUpperCase();
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
