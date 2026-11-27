import { randomUUID } from 'node:crypto';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiPackageRoot } from '../../src/config/paths.js';
import { migrateUp } from '../../src/infrastructure/db/migrator.js';
import { isEligible } from '../../src/modules/payouts/eligibility.js';
import { latestStatus, queuePayoutReview, requestPayout } from '../../src/modules/payouts/requests.js';
import { PayoutRejected } from '../../src/modules/payouts/requests.js';
import { approvePayout, rejectPayout } from '../../src/modules/payouts/review.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a database whose name ends with _test');
if (!new URL(databaseUrl).pathname.replace(/^\//, '').endsWith('_test')) {
  throw new Error(
    'Refusing to run integration tests against a database whose name does not end with _test',
  );
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

describe('payout eligibility on postgres', () => {
  beforeAll(async () => {
    await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('rejects 20 calendar days and 6 trading days and an open position', async () => {
    const short = await readyAccount({ days: 20, tradingDays: 7, verified: true });
    expect((await isEligible(pool, short.accountId, short.now)).reason).toBe('CALENDAR_DAYS');
    const few = await readyAccount({ days: 21, tradingDays: 6, verified: true });
    expect((await isEligible(pool, few.accountId, few.now)).reason).toBe('TRADING_DAYS');
    const open = await readyAccount({ days: 21, tradingDays: 7, verified: true, openPosition: true });
    expect((await isEligible(pool, open.accountId, open.now)).reason).toBe('OPEN_POSITION');
    const unverified = await readyAccount({ days: 21, tradingDays: 7, verified: false });
    expect((await isEligible(pool, unverified.accountId, unverified.now)).reason).toBe('KYC_REQUIRED');
  });

  it('opens a pending request and pays 70 percent through the sandbox', async () => {
    const ready = await readyAccount({ days: 21, tradingDays: 7, verified: true });
    const created = await requestPayout(pool, ready.accountId, ready.now);
    expect(created.status).toBe('PENDING');
    expect(created.traderAmount).toBe('70.0000');
    await queuePayoutReview(pool, created.requestId);
    const adminId = await adminUser();
    const paid = await approvePayout(pool, created.requestId, adminId);
    expect(paid.amount).toBe('70.0000');
    expect(paid.accountId).toBe(ready.accountId);
    expect(await latestStatus(pool, created.requestId)).toBe('PAID');
    const sandbox = await pool.query<{ amount: string; provider: string }>(
      `SELECT amount::text, provider FROM sandbox_payouts WHERE payout_request_id = $1`,
      [created.requestId],
    );
    expect(sandbox.rows[0]).toEqual({ amount: '70.0000', provider: 'sandbox' });
    const cash = await pool.query<{ cash: string }>(
      `SELECT cash::text FROM simulation_cash_projections WHERE account_id = $1`,
      [ready.accountId],
    );
    expect(cash.rows[0]?.cash).toBe('10100.0000');
  });

  it('refuses a rejection without a reason', async () => {
    const ready = await readyAccount({ days: 21, tradingDays: 7, verified: true });
    const created = await requestPayout(pool, ready.accountId, ready.now);
    await queuePayoutReview(pool, created.requestId);
    const adminId = await adminUser();
    await expect(rejectPayout(pool, created.requestId, adminId, '   ')).rejects.toBeInstanceOf(
      PayoutRejected,
    );
    expect(await latestStatus(pool, created.requestId)).toBe('UNDER_REVIEW');
  });
});

async function readyAccount(input: {
  days: number;
  tradingDays: number;
  verified: boolean;
  openPosition?: boolean;
}): Promise<{ accountId: string; now: Date }> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, email_verified_at) VALUES ($1, now()) RETURNING id`,
    [`payout-${suffix}@example.com`],
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
    [`payout-${suffix}`, `payout-ext-${suffix}`, userId, price.rows[0]?.id],
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
  const funded = new Date('2026-03-01T00:00:00.000Z');
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
    [`PO${suffix}`.slice(0, 12).toUpperCase(), `po${suffix}`],
  );
  const instrumentId = instrument.rows[0]?.id;
  const order = await pool.query<{ id: string }>(
    `INSERT INTO orders (
       account_id, user_id, instrument_id, client_order_id, side, order_type, state,
       quantity, filled_quantity, quote_asset, price_origin, live_market_data, feed_state
     ) VALUES ($1, $2, $3, $4, 'BUY', 'MARKET', 'FILLED', 1, 1, 'USD', 'TEST_FIXTURE', false, 'LIVE')
     RETURNING id`,
    [accountId, userId, instrumentId, randomUUID()],
  );
  const execution = await pool.query<{ id: string }>(
    `INSERT INTO executions (
       order_id, account_id, instrument_id, sequence_no, quantity, price, notional, commission,
       quote_update_id, received_at, executed_at, price_origin, live_market_data, execution_venue
     ) VALUES ($1, $2, $3, 1, 1, 10, 10, 0, '1', $4, $4, 'TEST_FIXTURE', false, 'K2_SIMULATION')
     RETURNING id`,
    [order.rows[0]?.id, accountId, instrumentId, funded],
  );
  for (let index = 0; index < input.tradingDays; index += 1) {
    const day = new Date(funded.getTime() + index * 86_400_000).toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO risk_trading_days (account_id, utc_date, first_execution_id) VALUES ($1, $2, $3)`,
      [accountId, day, execution.rows[0]?.id],
    );
  }
  if (input.openPosition && instrumentId) {
    await pool.query(
      `INSERT INTO positions (account_id, instrument_id, status, quantity) VALUES ($1, $2, 'OPEN', 1)`,
      [accountId, instrumentId],
    );
  }
  if (input.verified) {
    const kyc = await pool.query<{ id: string }>(
      `INSERT INTO kyc_cases (user_id, provider, provider_ref, actor_type)
       VALUES ($1, 'sandbox', $2, 'SYSTEM') RETURNING id`,
      [userId, `kyc_${suffix}`],
    );
    await pool.query(
      `INSERT INTO kyc_events (case_id, status, actor_type) VALUES ($1, 'VERIFIED', 'SYSTEM')`,
      [kyc.rows[0]?.id],
    );
  }
  return { accountId, now: new Date(funded.getTime() + input.days * 86_400_000) };
}

async function adminUser(): Promise<string> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, email_verified_at) VALUES ($1, now()) RETURNING id`,
    [`admin-${suffix}@example.com`],
  );
  const userId = user.rows[0]?.id;
  if (!userId) throw new Error('admin insert returned no id');
  await pool.query(
    `INSERT INTO user_roles (user_id, role_code, granted_by) VALUES ($1, 'ADMIN', $1)`,
    [userId],
  );
  return userId;
}
