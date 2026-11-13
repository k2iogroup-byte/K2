import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { Secret, TOTP } from 'otpauth';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { createInitialAdmin } from '../../src/cli/bootstrap-staff.js';
import { loadConfig } from '../../src/config/env.js';
import { apiPackageRoot } from '../../src/config/paths.js';
import { IdentityRepository } from '../../src/infrastructure/db/identity-repository.js';
import { migrateUp } from '../../src/infrastructure/db/migrator.js';
import { PgDatabaseProbe } from '../../src/infrastructure/db/probe.js';
import { createLogger } from '../../src/infrastructure/logging/logger.js';
import { AccountRepository } from '../../src/modules/accounts/account-repository.js';
import { AccountService } from '../../src/modules/accounts/account-service.js';
import type { VerifiedPurchaseEvidence } from '../../src/modules/accounts/integration-ports.js';
import {
  collectSubscription,
  postChallengeFee,
} from '../../src/modules/accounts/integration-ports.js';
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
const limiter = new MemoryRateLimiter();
let baseUrl = '';
let appClose: (() => Promise<void>) | null = null;
const accounts = new AccountService(new AccountRepository(pool));

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
    }),
  );
  const app = await buildApp({
    config,
    pool,
    emailSender: new CaptureEmailSender(null),
    limiter,
    database: new PgDatabaseProbe(pool, createLogger(config)),
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  appClose = async () => {
    await app.close();
  };
});

beforeEach(() => {
  limiter.clear();
});

afterAll(async () => {
  if (appClose) await appClose();
  await pool.end();
});

describe('module 03 challenge accounts', () => {
  it('publishes the confirmed catalogue and unresolved rule parameters', async () => {
    const catalogue = await call(new Map(), '/catalogue/challenges');
    expect(catalogue.status).toBe(200);
    const body = (await catalogue.json()) as {
      products: { accountSize: string; price: string; currency: string }[];
    };
    expect(
      body.products.map((product) => [product.accountSize, product.price, product.currency]),
    ).toEqual([
      ['10000.00', '129.00', 'USD'],
      ['25000.00', '250.00', 'USD'],
      ['50000.00', '399.00', 'USD'],
      ['100000.00', '699.00', 'USD'],
      ['200000.00', '1200.00', 'USD'],
    ]);
    expect(body.products.map((product) => product.accountSize)).not.toContain('5000.00');
    expect(body.products.map((product) => product.accountSize)).not.toContain('300000.00');

    const rules = await call(new Map(), '/catalogue/rulesets/current');
    expect(rules.status).toBe(200);
    const ruleBody = (await rules.json()) as {
      stages: {
        stage: string;
        parameters: { parameterKey: string; status: string; numericValue: string | null }[];
      }[];
    };
    const stage1 = new Map(
      ruleBody.stages
        .find((stage) => stage.stage === 'STAGE_1')
        ?.parameters.map((parameter) => [parameter.parameterKey, parameter]),
    );
    const stage2 = new Map(
      ruleBody.stages
        .find((stage) => stage.stage === 'STAGE_2')
        ?.parameters.map((parameter) => [parameter.parameterKey, parameter]),
    );
    expect(stage1.get('profit_target_pct')).toMatchObject({
      status: 'CONFIRMED',
      numericValue: '8.0000',
    });
    expect(stage2.get('profit_target_pct')).toMatchObject({
      status: 'CONFIRMED',
      numericValue: '5.0000',
    });
    expect(stage1.get('daily_loss_limit_pct')).toMatchObject({ numericValue: '5.0000' });
    expect(stage1.get('max_total_drawdown_pct')).toMatchObject({ numericValue: '8.0000' });
    expect(stage1.get('min_trading_days')).toMatchObject({ numericValue: '7' });
    expect(stage1.get('max_duration_days')).toMatchObject({ numericValue: '30' });
    expect(stage2.get('max_duration_days')).toMatchObject({ numericValue: '60' });
    expect(stage1.get('opening_commission_pct')).toMatchObject({ numericValue: '0.5000' });
    expect(stage1.get('closing_commission_pct')).toMatchObject({ numericValue: '0.0000' });
    expect(stage1.get('swap')).toMatchObject({ numericValue: '0.0000' });
    for (const key of [
      'drawdown_basis',
      'daily_loss_reference',
      'daily_reset_at',
      'trading_day_definition',
      'profit_target_basis',
      'duration_clock',
      'stage_transition',
      'breach_consequence',
      'commission_market_scope',
      'subscription_collection',
      'activation_condition',
    ]) {
      expect(stage1.get(key)).toMatchObject({ status: 'UNRESOLVED', numericValue: null });
      expect(stage2.get(key)).toMatchObject({ status: 'UNRESOLVED', numericValue: null });
    }
  });

  it('does not provision a challenge for an unverified trader', async () => {
    const owner = await registerTrader({ verify: false });
    const product = await openProduct('10000.00');
    await expect(
      accounts.provisionFromVerifiedPurchase(
        purchase(owner.userId, product.priceVersionId, '129.00'),
      ),
    ).rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    const rows = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM trading_accounts WHERE user_id = $1',
      [owner.userId],
    );
    expect(rows.rows[0]?.count).toBe(0);
  });

  it('provisions only from matching M-08 evidence and keeps the purchase immutable', async () => {
    const owner = await registerTrader();
    const intruder = await registerTrader();
    const product = await openProduct('10000.00');
    const evidence = purchase(owner.userId, product.priceVersionId, '129.00');
    const account = await accounts.provisionFromVerifiedPurchase(evidence);
    expect(account.state).toBe('PROVISIONED');
    expect(account.initialCapital).toBe('10000.00');
    expect(account.priceVersionId).toBe(product.priceVersionId);
    const replay = await accounts.provisionFromVerifiedPurchase(evidence);
    expect(replay.id).toBe(account.id);
    const rows = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM trading_accounts WHERE user_id = $1',
      [owner.userId],
    );
    expect(rows.rows[0]?.count).toBe(1);

    await expect(
      accounts.provisionFromVerifiedPurchase({
        ...evidence,
        idempotencyKey: `pay-${randomUUID()}`,
        amount: '1.00',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      accounts.provisionFromVerifiedPurchase({
        ...evidence,
        sourceSystem: 'CLIENT',
      } as unknown as VerifiedPurchaseEvidence),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect(() =>
      postChallengeFee({
        accountId: account.id,
        purchaseEvidenceId: 'evidence',
        priceVersionId: product.priceVersionId,
        amount: '129.00',
        currency: 'USD',
      }),
    ).toThrow(/ledger/i);
    expect(() => collectSubscription()).toThrow(/subscription/i);
    const missing = await pool.query(
      `SELECT to_regclass('public.journal_entries') AS journal, to_regclass('public.subscriptions') AS subscriptions`,
    );
    expect(missing.rows[0]).toEqual({ journal: null, subscriptions: null });

    expect(
      (await call(new Map(), '/checkout/challenge', { method: 'POST', body: {} })).status,
    ).toBe(404);
    expect((await call(owner.jar, '/accounts', { method: 'POST', body: {} })).status).toBe(404);
    expect((await call(owner.jar, `/accounts/${account.id}/metrics`)).status).toBe(404);

    const listed = await call(owner.jar, '/accounts');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      accounts: [{ id: account.id, state: 'PROVISIONED' }],
    });
    expect((await call(intruder.jar, `/accounts/${account.id}`)).status).toBe(404);
    expect((await call(new Map(), '/accounts')).status).toBe(401);

    await expect(
      pool.query('UPDATE trading_accounts SET initial_capital = 1 WHERE id = $1', [account.id]),
    ).rejects.toThrow(/immutable/i);
    await expect(pool.query('UPDATE rule_parameters SET numeric_value = 9')).rejects.toThrow(
      /append-only/i,
    );
    await expect(pool.query('UPDATE product_price_versions SET price = 1')).rejects.toThrow(
      /immutable/i,
    );
    await expect(
      pool.query('DELETE FROM account_state_transitions WHERE account_id = $1', [account.id]),
    ).rejects.toThrow(/append-only/i);
  });

  it('keeps later catalogue and rule versions off existing accounts', async () => {
    const trader = await registerTrader();
    const admin = await staffAdmin();
    const product = await openProduct('25000.00');
    const first = await accounts.provisionFromVerifiedPurchase(
      purchase(trader.userId, product.priceVersionId, '250.00'),
    );
    const deactivated = await call(
      admin.jar,
      `/staff/catalogue/products/${product.productId}/activation`,
      {
        method: 'POST',
        body: { active: false, reason: 'Temporarily withdrawn from sale' },
        idempotencyKey: `deactivate-${randomUUID()}`,
      },
    );
    expect(deactivated.status).toBe(200);
    const hidden = (await (await call(new Map(), '/catalogue/challenges')).json()) as {
      products: { accountSize: string }[];
    };
    expect(hidden.products.some((item) => item.accountSize === '25000.00')).toBe(false);
    await expect(
      accounts.provisionFromVerifiedPurchase(
        purchase(trader.userId, product.priceVersionId, '250.00'),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const unchanged = await pool.query<{ state: string; price_version_id: string }>(
      'SELECT state, price_version_id FROM trading_accounts WHERE id = $1',
      [first.id],
    );
    expect(unchanged.rows[0]).toEqual({
      state: 'PROVISIONED',
      price_version_id: product.priceVersionId,
    });

    const reactivated = await call(
      admin.jar,
      `/staff/catalogue/products/${product.productId}/activation`,
      {
        method: 'POST',
        body: { active: true, reason: 'Returned to the active catalogue' },
        idempotencyKey: `activate-${randomUUID()}`,
      },
    );
    expect(reactivated.status).toBe(200);
    const priced = await call(admin.jar, `/staff/catalogue/products/${product.productId}/prices`, {
      method: 'POST',
      body: { price: '275.00', decisionRef: 'BR-101-REVISION' },
      idempotencyKey: `price-${randomUUID()}`,
    });
    expect(priced.status).toBe(201);
    const priceBody = (await priced.json()) as { priceVersionId: string };
    const second = await accounts.provisionFromVerifiedPurchase(
      purchase(trader.userId, priceBody.priceVersionId, '275.00'),
    );
    expect(second.priceVersionId).not.toBe(first.priceVersionId);
    const stillOld = await pool.query<{ price_version_id: string }>(
      'SELECT price_version_id FROM trading_accounts WHERE id = $1',
      [first.id],
    );
    expect(stillOld.rows[0]?.price_version_id).toBe(first.priceVersionId);
    await expect(
      pool.query('UPDATE product_price_versions SET price = 1 WHERE id = $1', [
        first.priceVersionId,
      ]),
    ).rejects.toThrow(/immutable/i);

    const blockedRule = await call(admin.jar, '/staff/rulesets', {
      method: 'POST',
      body: {
        decisionRef: 'OQ-001-ATTEMPT',
        changes: [{ stage: 'STAGE_1', parameterKey: 'drawdown_basis', numericValue: '1' }],
      },
      idempotencyKey: `rule-blocked-${randomUUID()}`,
    });
    expect(blockedRule.status).toBe(409);
    const published = await call(admin.jar, '/staff/rulesets', {
      method: 'POST',
      body: {
        decisionRef: 'BR-120-REVISION',
        changes: [{ stage: 'STAGE_1', parameterKey: 'profit_target_pct', numericValue: '9' }],
      },
      idempotencyKey: `rule-ok-${randomUUID()}`,
    });
    expect(published.status).toBe(201);
    const third = await accounts.provisionFromVerifiedPurchase(
      purchase(trader.userId, priceBody.priceVersionId, '275.00'),
    );
    expect(third.ruleSetVersionId).not.toBe(first.ruleSetVersionId);
    const oldRule = await pool.query<{ rule_set_version_id: string }>(
      'SELECT rule_set_version_id FROM trading_accounts WHERE id = $1',
      [first.id],
    );
    expect(oldRule.rows[0]?.rule_set_version_id).toBe(first.ruleSetVersionId);

    const removed = await call(admin.jar, '/staff/catalogue/products', {
      method: 'POST',
      body: { accountSize: '5000.00', price: '50.00', decisionRef: 'BR-107-REJECTED' },
      idempotencyKey: `size-5000-${randomUUID()}`,
    });
    expect(removed.status).toBe(400);
    const removedLarge = await call(admin.jar, '/staff/catalogue/products', {
      method: 'POST',
      body: { accountSize: '300000.00', price: '50.00', decisionRef: 'BR-107-REJECTED' },
      idempotencyKey: `size-300-${randomUUID()}`,
    });
    expect(removedLarge.status).toBe(400);
    const added = await call(admin.jar, '/staff/catalogue/products', {
      method: 'POST',
      body: { accountSize: '15000.00', price: '180.00', decisionRef: 'D-TEST-15000' },
      idempotencyKey: `size-15000-${randomUUID()}`,
    });
    expect(added.status).toBe(201);
  });

  it('records authorised transitions once and blocks pass, fail, and expiry', async () => {
    const trader = await registerTrader();
    const admin = await staffAdmin();
    const support = await registerTrader();
    await pool.query(
      `INSERT INTO user_roles (user_id, role_code, granted_by) VALUES ($1, 'SUPPORT', $2)`,
      [support.userId, admin.userId],
    );
    const supportEnroll = await call(support.jar, '/auth/mfa/enroll', { method: 'POST' });
    const supportSecret = ((await supportEnroll.json()) as { secret: string }).secret;
    expect(
      (
        await call(support.jar, '/auth/mfa/verify', {
          method: 'POST',
          body: { code: totp(supportSecret) },
        })
      ).status,
    ).toBe(200);

    const product = await openProduct('50000.00');
    const account = await accounts.provisionFromVerifiedPurchase(
      purchase(trader.userId, product.priceVersionId, '399.00'),
    );
    const key = `suspend-${randomUUID()}`;
    const suspend = await call(admin.jar, `/staff/accounts/${account.id}/transitions`, {
      method: 'POST',
      body: { toState: 'SUSPENDED', reasonCode: 'STAFF_SUSPEND', reason: 'Compliance review hold' },
      idempotencyKey: key,
    });
    expect(suspend.status).toBe(200);
    const firstBody = await suspend.json();
    const replay = await call(admin.jar, `/staff/accounts/${account.id}/transitions`, {
      method: 'POST',
      body: { toState: 'SUSPENDED', reasonCode: 'STAFF_SUSPEND', reason: 'Compliance review hold' },
      idempotencyKey: key,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    const count = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM account_state_transitions WHERE account_id = $1 AND to_state = 'SUSPENDED'`,
      [account.id],
    );
    expect(count.rows[0]?.count).toBe(1);
    const conflict = await call(admin.jar, `/staff/accounts/${account.id}/transitions`, {
      method: 'POST',
      body: { toState: 'CLOSED', reasonCode: 'STAFF_CLOSE', reason: 'Different command same key' },
      idempotencyKey: key,
    });
    expect(conflict.status).toBe(409);

    const passed = await call(admin.jar, `/staff/accounts/${account.id}/transitions`, {
      method: 'POST',
      body: { toState: 'PASSED', reasonCode: 'STAFF_CLOSE', reason: 'Attempted manual pass' },
      idempotencyKey: `pass-${randomUUID()}`,
    });
    expect(passed.status).toBe(409);
    const passedBody = (await passed.json()) as {
      error: { code: string; details?: { message: string }[] };
    };
    expect(passedBody.error.code).toBe('UNRESOLVED_RULE');
    expect(passedBody.error.details?.[0]?.message).toBe('OQ-003');
    const rejected = await pool.query(
      `SELECT 1 FROM challenge_audit_events WHERE event_type = 'account.transition_rejected' AND target_account_id = $1`,
      [account.id],
    );
    expect(rejected.rowCount).toBe(1);

    expect(
      (
        await call(support.jar, `/staff/accounts/${account.id}/transitions`, {
          method: 'POST',
          body: { toState: 'CLOSED', reasonCode: 'STAFF_CLOSE', reason: 'Support cannot close' },
          idempotencyKey: `support-${randomUUID()}`,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(trader.jar, `/staff/accounts/${account.id}/transitions`, {
          method: 'POST',
          body: { toState: 'CLOSED', reasonCode: 'STAFF_CLOSE', reason: 'Trader cannot close' },
          idempotencyKey: `trader-${randomUUID()}`,
        })
      ).status,
    ).toBe(403);

    const resumed = await call(admin.jar, `/staff/accounts/${account.id}/transitions`, {
      method: 'POST',
      body: {
        toState: 'PROVISIONED',
        reasonCode: 'STAFF_RESUME',
        reason: 'Hold completed without a finding',
      },
      idempotencyKey: `resume-${randomUUID()}`,
    });
    expect(resumed.status).toBe(200);
    const closed = await call(admin.jar, `/staff/accounts/${account.id}/transitions`, {
      method: 'POST',
      body: { toState: 'CLOSED', reasonCode: 'STAFF_CLOSE', reason: 'Closed by an administrator' },
      idempotencyKey: `close-${randomUUID()}`,
    });
    expect(closed.status).toBe(200);
    const afterClose = await call(admin.jar, `/staff/accounts/${account.id}/transitions`, {
      method: 'POST',
      body: {
        toState: 'SUSPENDED',
        reasonCode: 'STAFF_SUSPEND',
        reason: 'Closed accounts stay closed',
      },
      idempotencyKey: `after-close-${randomUUID()}`,
    });
    expect(afterClose.status).toBe(409);
    const history = await call(trader.jar, `/accounts/${account.id}/history`);
    expect(history.status).toBe(200);
    const historyBody = (await history.json()) as {
      transitions: { toState: string; actorType: string }[];
    };
    expect(historyBody.transitions.map((transition) => transition.toState)).toEqual([
      'PROVISIONED',
      'SUSPENDED',
      'PROVISIONED',
      'CLOSED',
    ]);
    expect(historyBody.transitions[0]?.actorType).toBe('SYSTEM');
  });
});

async function openProduct(size: string): Promise<{ productId: string; priceVersionId: string }> {
  const result = await pool.query<{ product_id: string; id: string }>(
    `SELECT v.product_id, v.id
     FROM product_price_versions v
     JOIN challenge_products p ON p.id = v.product_id
     WHERE p.account_size = $1::numeric AND v.valid_to IS NULL`,
    [size],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Missing product ${size}`);
  return { productId: row.product_id, priceVersionId: row.id };
}

let cachedAdmin: { jar: Jar; userId: string } | null = null;

function purchase(
  userId: string,
  priceVersionId: string,
  amount: string,
): VerifiedPurchaseEvidence {
  return {
    sourceSystem: 'M-08',
    idempotencyKey: `pay-${randomUUID()}`,
    externalReference: `ref-${randomUUID()}`,
    userId,
    priceVersionId,
    amount,
    currency: 'USD',
    verifiedAt: new Date().toISOString(),
  };
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
  expect(enrolled.status).toBe(200);
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
  init?: { method?: string; body?: unknown; idempotencyKey?: string },
): Promise<Response> {
  const method = init?.method ?? (init?.body === undefined ? 'GET' : 'POST');
  const headers = new Headers();
  if (method !== 'GET' && method !== 'HEAD') headers.set('x-k2-request', '1');
  if (init?.body !== undefined) headers.set('content-type', 'application/json');
  if (init?.idempotencyKey) headers.set('idempotency-key', init.idempotencyKey);
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
