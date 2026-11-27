import { randomUUID } from 'node:crypto';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/env.js';
import { apiPackageRoot } from '../../src/config/paths.js';
import { migrateUp } from '../../src/infrastructure/db/migrator.js';
import {
  applyKycWebhook,
  checkStatus,
  decideKyc,
  submitDocuments,
} from '../../src/modules/kyc/kyc-service.js';
import { signSandboxKyc } from '../../src/modules/kyc/sandbox.js';
import { isEligible } from '../../src/modules/payouts/eligibility.js';
import { requestPayout } from '../../src/modules/payouts/requests.js';
import { validEnv } from '../valid-env.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a database whose name ends with _test');
if (!new URL(databaseUrl).pathname.replace(/^\//, '').endsWith('_test')) {
  throw new Error(
    'Refusing to run integration tests against a database whose name does not end with _test',
  );
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

describe('sandbox KYC on postgres', () => {
  beforeAll(async () => {
    await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('rejects an unverified payout, then allows it after a super admin verifies', async () => {
    expect(loadConfig(validEnv()).kycProvider).toBe('sandbox');
    expect(() => loadConfig(validEnv({ KYC_PROVIDER: 'live' }))).toThrow(/KYC_PROVIDER/);
    const ready = await fundedAccount();
    expect((await isEligible(pool, ready.accountId, ready.now)).reason).toBe('KYC_REQUIRED');
    await submitDocuments(pool, ready.userId, ['sandbox-doc-1']);
    expect(await checkStatus(pool, ready.userId)).toBe('PENDING');
    const providerRef = (
      await pool.query<{ provider_ref: string }>(
        `SELECT provider_ref FROM kyc_cases WHERE user_id = $1`,
        [ready.userId],
      )
    ).rows[0]?.provider_ref;
    const body = JSON.stringify({ providerRef, status: 'UNDER_REVIEW' });
    expect(await applyKycWebhook(pool, body, 'bad-signature')).toBe('rejected');
    expect(await applyKycWebhook(pool, body, signSandboxKyc(body))).toBe('accepted');
    expect(await checkStatus(pool, ready.userId)).toBe('UNDER_REVIEW');
    const adminId = await adminUser();
    await decideKyc(pool, ready.userId, adminId, 'VERIFIED', '');
    expect(await checkStatus(pool, ready.userId)).toBe('VERIFIED');
    const created = await requestPayout(pool, ready.accountId, ready.now);
    expect(created.status).toBe('PENDING');
    const stored = await pool.query(
      `SELECT provider_document_id FROM kyc_document_refs
       JOIN kyc_cases ON kyc_cases.id = kyc_document_refs.case_id
       WHERE kyc_cases.user_id = $1`,
      [ready.userId],
    );
    expect(stored.rows).toEqual([{ provider_document_id: 'sandbox-doc-1' }]);
  });
});

async function fundedAccount(): Promise<{ userId: string; accountId: string; now: Date }> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, email_verified_at) VALUES ($1, now()) RETURNING id`,
    [`kyc-${suffix}@example.com`],
  );
  const userId = user.rows[0]?.id;
  if (!userId) throw new Error('user insert returned no id');
  const price = await pool.query<{ id: string }>(
    `SELECT id FROM product_price_versions ORDER BY valid_from LIMIT 1`,
  );
  const evidence = await pool.query<{ id: string }>(
    `INSERT INTO purchase_evidence_references (
       source_system, idempotency_key, external_reference, user_id, price_version_id,
       amount, currency, verified_at
     ) VALUES ('M-08', $1, $2, $3, $4, 100, 'USD', now())
     RETURNING id`,
    [`kyc-${suffix}`, `kyc-ext-${suffix}`, userId, price.rows[0]?.id],
  );
  const account = await pool.query<{ id: string }>(
    `INSERT INTO trading_accounts (
       user_id, account_type, stage, state, initial_capital, currency, product_id,
       price_version_id, rule_set_version_id, purchase_evidence_id, provisioned_at
     )
     SELECT $1, 'CHALLENGE', 'STAGE_1', 'ACTIVE', 10000, 'USD', products.id,
            versions.id, rules.id, $2, now()
     FROM challenge_products AS products
     JOIN product_price_versions AS versions ON versions.product_id = products.id
     JOIN rule_set_versions AS rules ON true
     WHERE products.account_size = 10000
     LIMIT 1
     RETURNING id`,
    [userId, evidence.rows[0]?.id],
  );
  const accountId = account.rows[0]?.id;
  if (!accountId) throw new Error('account was not inserted');
  const funded = new Date('2026-04-01T00:00:00.000Z');
  await pool.query(
    `INSERT INTO funded_activations (account_id, activated_at, actor_type) VALUES ($1, $2, 'SYSTEM')`,
    [accountId, funded],
  );
  await pool.query(
    `INSERT INTO simulation_cash_projections (account_id, cash) VALUES ($1, 10100)`,
    [accountId],
  );
  await pool.query(
    `INSERT INTO journal_entries (account_id, entry_type, amount, cash_effect, idempotency_key, actor_type)
     VALUES ($1, 'OPENING', 10000, true, $2, 'SYSTEM'),
            ($1, 'FILL', 100, true, $3, 'SYSTEM')`,
    [accountId, `opening:${accountId}`, `profit:${accountId}`],
  );
  const instrument = await pool.query<{ id: string }>(
    `INSERT INTO instruments (
       market, venue, symbol, provider_symbol, price_scale, quantity_scale, trading_status, quote_asset
     ) VALUES ('EQUITIES', 'NASDAQ', $1, $2, 2, 8, 'TRADABLE', 'USD')
     RETURNING id`,
    [`KY${suffix}`.slice(0, 12).toUpperCase(), `ky${suffix}`],
  );
  const order = await pool.query<{ id: string }>(
    `INSERT INTO orders (
       account_id, user_id, instrument_id, client_order_id, side, order_type, state,
       quantity, filled_quantity, quote_asset, price_origin, live_market_data, feed_state
     ) VALUES ($1, $2, $3, $4, 'BUY', 'MARKET', 'FILLED', 1, 1, 'USD', 'TEST_FIXTURE', false, 'LIVE')
     RETURNING id`,
    [accountId, userId, instrument.rows[0]?.id, randomUUID()],
  );
  const execution = await pool.query<{ id: string }>(
    `INSERT INTO executions (
       order_id, account_id, instrument_id, sequence_no, quantity, price, notional, commission,
       quote_update_id, received_at, executed_at, price_origin, live_market_data, execution_venue
     ) VALUES ($1, $2, $3, 1, 1, 10, 10, 0, '1', $4, $4, 'TEST_FIXTURE', false, 'K2_SIMULATION')
     RETURNING id`,
    [order.rows[0]?.id, accountId, instrument.rows[0]?.id, funded],
  );
  for (let index = 0; index < 7; index += 1) {
    const day = new Date(funded.getTime() + index * 86_400_000).toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO risk_trading_days (account_id, utc_date, first_execution_id) VALUES ($1, $2, $3)`,
      [accountId, day, execution.rows[0]?.id],
    );
  }
  return { userId, accountId, now: new Date(funded.getTime() + 21 * 86_400_000) };
}

async function adminUser(): Promise<string> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, email_verified_at) VALUES ($1, now()) RETURNING id`,
    [`kyc-admin-${suffix}@example.com`],
  );
  const userId = user.rows[0]?.id;
  if (!userId) throw new Error('admin insert returned no id');
  await pool.query(
    `INSERT INTO user_roles (user_id, role_code, granted_by) VALUES ($1, 'ADMIN', $1)`,
    [userId],
  );
  return userId;
}
