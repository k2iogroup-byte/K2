import { randomUUID } from 'node:crypto';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/env.js';
import { apiPackageRoot } from '../../src/config/paths.js';
import { migrateUp } from '../../src/infrastructure/db/migrator.js';
import { AccountRepository } from '../../src/modules/accounts/account-repository.js';
import { AccountService } from '../../src/modules/accounts/account-service.js';
import { accrueSubscriptions } from '../../src/modules/ledger/subscription.js';
import {
  collectSubscription,
  configuredGraceDays,
  expireSubscriptionGrace,
} from '../../src/modules/payments/billing.js';
import { createChallengeCharge } from '../../src/modules/payments/purchase.js';
import { SandboxPaymentProvider, signSandboxWebhook } from '../../src/modules/payments/sandbox.js';
import { applyWebhook } from '../../src/modules/payments/webhook.js';
import { validEnv } from '../valid-env.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a database whose name ends with _test');
if (!new URL(databaseUrl).pathname.replace(/^\//, '').endsWith('_test')) {
  throw new Error(
    'Refusing to run integration tests against a database whose name does not end with _test',
  );
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const provider = new SandboxPaymentProvider();
const accounts = new AccountService(new AccountRepository(pool));

describe('sandbox payments on postgres', () => {
  beforeAll(async () => {
    await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('provisions an account from a signed webhook and ignores a repeat', async () => {
    expect(loadConfig(validEnv()).paymentProvider).toBe('sandbox');
    expect(() => loadConfig(validEnv({ PAYMENT_PROVIDER: 'live' }))).toThrow(/PAYMENT_PROVIDER/);
    const userId = await verifiedUser();
    const price = await pool.query<{ id: string; price: string }>(
      `SELECT versions.id, versions.price::text
       FROM product_price_versions AS versions
       JOIN challenge_products AS products ON products.id = versions.product_id
       WHERE products.account_size = 10000
       ORDER BY versions.valid_from
       LIMIT 1`,
    );
    const priceVersionId = price.rows[0]?.id ?? '';
    const started = await createChallengeCharge(pool, provider, {
      userId,
      priceVersionId,
      idempotencyKey: `buy-${randomUUID()}`,
    });
    const eventId = `evt${randomUUID().replaceAll('-', '')}`.slice(0, 32);
    const body = JSON.stringify({
      eventId,
      providerRef: started.providerRef,
      outcome: 'SUCCEEDED',
    });
    expect(
      await applyWebhook(pool, provider, accounts, body, 'not-a-signature', new Date(), null),
    ).toBe('rejected');
    const now = new Date();
    expect(
      await applyWebhook(pool, provider, accounts, body, signSandboxWebhook(body), now, null),
    ).toBe('accepted');
    expect(
      await applyWebhook(pool, provider, accounts, body, signSandboxWebhook(body), now, null),
    ).toBe('duplicate');
    const rows = await pool.query<{ state: string }>(
      `SELECT state FROM trading_accounts WHERE user_id = $1`,
      [userId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]?.state).toBe('PROVISIONED');
    const events = await pool.query(`SELECT id FROM payment_events WHERE provider_event_id = $1`, [
      eventId,
    ]);
    expect(events.rowCount).toBe(1);
  });

  it('keeps a failed subscription active and opens a human review', async () => {
    expect(configuredGraceDays(undefined)).toBeNull();
    expect(configuredGraceDays('7')).toBe(7);
    const userId = await verifiedUser();
    const account = await pool.query<{ id: string }>(
      `INSERT INTO trading_accounts (
         user_id, account_type, stage, state, initial_capital, currency, product_id,
         price_version_id, rule_set_version_id, purchase_evidence_id, provisioned_at
       )
       SELECT $1, 'CHALLENGE', 'STAGE_1', 'ACTIVE', products.account_size, 'USD', products.id,
              versions.id, rule_versions.id, evidence.id, now()
       FROM challenge_products AS products
       JOIN product_price_versions AS versions ON versions.product_id = products.id
       JOIN purchase_evidence_references AS evidence ON evidence.user_id = $1
       JOIN rule_set_versions AS rule_versions ON true
       WHERE products.account_size = 10000
       LIMIT 1
       RETURNING id`,
      [userId],
    );
    const accountId = account.rows[0]?.id;
    if (!accountId) throw new Error('account was not inserted');
    const instrument = await pool.query<{ id: string }>(
      `INSERT INTO instruments (
         market, venue, symbol, provider_symbol, price_scale, quantity_scale, trading_status, quote_asset
       ) VALUES ('EQUITIES', 'NASDAQ', $1, $2, 2, 8, 'TRADABLE', 'USD')
       RETURNING id`,
      [`PM${randomUUID().slice(0, 8)}`.toUpperCase(), `pm${randomUUID().slice(0, 8)}`],
    );
    const order = await pool.query<{ id: string }>(
      `INSERT INTO orders (
         account_id, user_id, instrument_id, client_order_id, side, order_type, state,
         quantity, filled_quantity, quote_asset, price_origin, live_market_data, feed_state
       ) VALUES ($1, $2, $3, $4, 'BUY', 'MARKET', 'FILLED', 1, 1, 'USD', 'TEST_FIXTURE', false, 'LIVE')
       RETURNING id`,
      [accountId, userId, instrument.rows[0]?.id, randomUUID()],
    );
    await pool.query(
      `INSERT INTO executions (
         order_id, account_id, instrument_id, sequence_no, quantity, price, notional, commission,
         quote_update_id, received_at, executed_at, price_origin, live_market_data, execution_venue
       ) VALUES ($1, $2, $3, 1, 1, 10, 10, 0, '1', $4, $4, 'TEST_FIXTURE', false, 'K2_SIMULATION')`,
      [order.rows[0]?.id, accountId, instrument.rows[0]?.id, new Date('2026-01-01T00:00:00.000Z')],
    );
    await accrueSubscriptions(pool, new Date('2026-01-01T00:00:00.000Z'));
    const due = await pool.query<{ id: string }>(
      `SELECT id FROM subscription_charges WHERE account_id = $1`,
      [accountId],
    );
    const subscriptionChargeId = due.rows[0]?.id ?? '';
    const failed = await collectSubscription(pool, provider, subscriptionChargeId, 'fail');
    const failedBody = JSON.stringify({
      eventId: `evt${randomUUID().replaceAll('-', '')}`.slice(0, 32),
      providerRef: failed.providerRef,
      outcome: 'FAILED',
    });
    const started = new Date('2026-02-01T00:00:00.000Z');
    expect(
      await applyWebhook(
        pool,
        provider,
        accounts,
        failedBody,
        signSandboxWebhook(failedBody),
        started,
        3,
      ),
    ).toBe('accepted');
    const during = await pool.query<{ state: string; reviews: number }>(
      `SELECT accounts.state,
              (SELECT count(*) FROM human_review_items WHERE account_id = accounts.id)::int AS reviews
       FROM trading_accounts AS accounts WHERE id = $1`,
      [accountId],
    );
    expect(during.rows[0]).toEqual({ state: 'ACTIVE', reviews: 0 });
    await expireSubscriptionGrace(pool, new Date('2026-02-04T00:00:00.000Z'));
    const expired = await pool.query<{ state: string; reviews: number }>(
      `SELECT accounts.state,
              (SELECT count(*) FROM human_review_items WHERE account_id = accounts.id)::int AS reviews
       FROM trading_accounts AS accounts WHERE id = $1`,
      [accountId],
    );
    expect(expired.rows[0]).toEqual({ state: 'ACTIVE', reviews: 1 });
  });
});

async function verifiedUser(): Promise<string> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, email_verified_at) VALUES ($1, now()) RETURNING id`,
    [`pay-${suffix}@example.com`],
  );
  const userId = user.rows[0]?.id;
  if (!userId) throw new Error('user insert returned no id');
  const price = await pool.query<{ id: string }>(
    `SELECT id FROM product_price_versions ORDER BY valid_from LIMIT 1`,
  );
  await pool.query(
    `INSERT INTO purchase_evidence_references (
       source_system, idempotency_key, external_reference, user_id, price_version_id,
       amount, currency, verified_at
     ) VALUES ('M-08', $1, $2, $3, $4, 100, 'USD', now())`,
    [`seed-${suffix}`, `ext-${suffix}`, userId, price.rows[0]?.id],
  );
  return userId;
}
