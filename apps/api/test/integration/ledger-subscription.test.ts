import { randomUUID } from 'node:crypto';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiPackageRoot } from '../../src/config/paths.js';
import { migrateUp } from '../../src/infrastructure/db/migrator.js';
import { postedCash } from '../../src/modules/ledger/drain.js';
import { accrueSubscriptions } from '../../src/modules/ledger/subscription.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a database whose name ends with _test');
if (!new URL(databaseUrl).pathname.replace(/^\//, '').endsWith('_test')) {
  throw new Error(
    'Refusing to run integration tests against a database whose name does not end with _test',
  );
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const DAY = 86_400_000;

describe('subscription accrual on postgres', () => {
  beforeAll(async () => {
    await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('charges from the first execution every 30 days and leaves cash unchanged', async () => {
    const ids = await makeAccount('ACTIVE');
    const first = new Date('2026-01-01T00:00:00.000Z');
    await insertExecution(ids, first);
    const cashBefore = await readCash(ids.accountId);
    await accrueSubscriptions(pool, new Date(first.getTime() - DAY));
    expect(await chargeCount(ids.accountId)).toBe(0);
    await accrueSubscriptions(pool, first);
    expect(await chargeCount(ids.accountId)).toBe(1);
    await accrueSubscriptions(pool, new Date(first.getTime() + 29 * DAY));
    expect(await chargeCount(ids.accountId)).toBe(1);
    await accrueSubscriptions(pool, new Date(first.getTime() + 30 * DAY));
    expect(await chargeCount(ids.accountId)).toBe(2);
    const amounts = await pool.query<{ amount: string }>(
      `SELECT amount::text FROM subscription_charges WHERE account_id = $1 ORDER BY period_start`,
      [ids.accountId],
    );
    expect(amounts.rows).toEqual([{ amount: '10.0000' }, { amount: '10.0000' }]);
    expect(await readCash(ids.accountId)).toBe(cashBefore);
    const state = await pool.query<{ state: string }>(
      `SELECT state FROM trading_accounts WHERE id = $1`,
      [ids.accountId],
    );
    expect(state.rows[0]?.state).toBe('ACTIVE');
  });

  it('does not accrue for a failed account', async () => {
    const ids = await makeAccount('FAILED');
    await insertExecution(ids, new Date('2026-01-01T00:00:00.000Z'));
    await accrueSubscriptions(pool, new Date('2026-03-01T00:00:00.000Z'));
    expect(await chargeCount(ids.accountId)).toBe(0);
  });
});

async function readCash(accountId: string): Promise<string> {
  const client = await pool.connect();
  try {
    return await postedCash(client, accountId);
  } finally {
    client.release();
  }
}

async function chargeCount(accountId: string): Promise<number> {
  const row = await pool.query(`SELECT id FROM subscription_charges WHERE account_id = $1`, [
    accountId,
  ]);
  return row.rowCount ?? 0;
}

async function insertExecution(
  ids: { accountId: string; userId: string; instrumentId: string },
  executedAt: Date,
): Promise<void> {
  const order = await pool.query<{ id: string }>(
    `INSERT INTO orders (
       account_id, user_id, instrument_id, client_order_id, side, order_type, state,
       quantity, filled_quantity, quote_asset, price_origin, live_market_data, feed_state
     ) VALUES ($1, $2, $3, $4, 'BUY', 'MARKET', 'FILLED', 1, 1, 'USD', 'TEST_FIXTURE', false, 'LIVE')
     RETURNING id`,
    [ids.accountId, ids.userId, ids.instrumentId, randomUUID()],
  );
  await pool.query(
    `INSERT INTO executions (
       order_id, account_id, instrument_id, sequence_no, quantity, price, notional, commission,
       quote_update_id, received_at, executed_at, price_origin, live_market_data, execution_venue
     ) VALUES ($1, $2, $3, 1, 1, 10, 10, 0, '1', $4, $4, 'TEST_FIXTURE', false, 'K2_SIMULATION')`,
    [order.rows[0]?.id, ids.accountId, ids.instrumentId, executedAt],
  );
}

async function makeAccount(state: 'ACTIVE' | 'FAILED'): Promise<{
  userId: string;
  accountId: string;
  instrumentId: string;
}> {
  const client = await pool.connect();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>(
      'INSERT INTO users (email) VALUES ($1) RETURNING id',
      [`sub-${suffix}@example.com`],
    );
    const userId = required(user.rows[0]?.id);
    const picked = 25000 + (Number.parseInt(suffix.slice(0, 4), 16) % 700000);
    const size = (picked === 300000 ? 300001 : picked).toFixed(4);
    const product = await client.query<{ id: string }>(
      `INSERT INTO challenge_products (account_size, currency, active)
       VALUES ($1, 'USD', true) RETURNING id`,
      [size],
    );
    const productId = required(product.rows[0]?.id);
    const price = await client.query<{ id: string }>(
      `INSERT INTO product_price_versions (product_id, price, currency, valid_from, decision_ref)
       VALUES ($1, 100, 'USD', now(), $2) RETURNING id`,
      [productId, `P-${suffix}`.slice(0, 64)],
    );
    const priceId = required(price.rows[0]?.id);
    const rules = await client.query<{ id: string }>(
      `INSERT INTO rule_sets (code, account_type) VALUES ($1, 'CHALLENGE') RETURNING id`,
      [`RULE_${suffix}`.slice(0, 40).toUpperCase()],
    );
    const ruleSetId = required(rules.rows[0]?.id);
    const version = await client.query<{ id: string }>(
      `INSERT INTO rule_set_versions (rule_set_id, version_number, decision_ref, published_at)
       VALUES ($1, 1, $2, now()) RETURNING id`,
      [ruleSetId, `R-${suffix}`.slice(0, 64)],
    );
    const versionId = required(version.rows[0]?.id);
    await client.query(
      `INSERT INTO commission_market_scopes (rule_set_version_id, market, decision_ref)
       VALUES ($1, 'EQUITIES', $2)`,
      [versionId, `C-${suffix}`.slice(0, 64)],
    );
    const evidence = await client.query<{ id: string }>(
      `INSERT INTO purchase_evidence_references (
         source_system, idempotency_key, external_reference, user_id, price_version_id,
         amount, currency, verified_at
       ) VALUES ('M-08', $1, $2, $3, $4, 100, 'USD', now())
       RETURNING id`,
      [`buy-${suffix}`, `ext-${suffix}`, userId, priceId],
    );
    const account = await client.query<{ id: string }>(
      `INSERT INTO trading_accounts (
         user_id, account_type, stage, state, initial_capital, currency, product_id,
         price_version_id, rule_set_version_id, purchase_evidence_id, provisioned_at
       ) VALUES ($1, 'CHALLENGE', 'STAGE_1', 'PROVISIONED', 10000, 'USD', $2, $3, $4, $5, now())
       RETURNING id`,
      [userId, productId, priceId, versionId, required(evidence.rows[0]?.id)],
    );
    const accountId = required(account.rows[0]?.id);
    await client.query(
      `INSERT INTO account_state_transitions (
         account_id, from_state, to_state, reason_code, reason, actor_type, idempotency_key
       ) VALUES ($1, 'PROVISIONED', 'ACTIVE', 'SYSTEM_ACTIVATE', 'test activation for ledger', 'SYSTEM', $2)`,
      [accountId, `activate-${suffix}`],
    );
    await client.query(`UPDATE trading_accounts SET state = 'ACTIVE' WHERE id = $1`, [accountId]);
    if (state === 'FAILED') {
      await client.query(
        `INSERT INTO account_state_transitions (
           account_id, from_state, to_state, reason_code, reason, actor_type, idempotency_key
         ) VALUES ($1, 'ACTIVE', 'FAILED', 'RISK_BREACH', 'test fail for subscription', 'SYSTEM', $2)`,
        [accountId, `fail-${suffix}`],
      );
      await client.query(`UPDATE trading_accounts SET state = 'FAILED' WHERE id = $1`, [accountId]);
    }
    const symbol = `SB${suffix}`.slice(0, 20).toUpperCase();
    const instrument = await client.query<{ id: string }>(
      `INSERT INTO instruments (
         market, venue, symbol, provider_symbol, price_scale, quantity_scale, trading_status, quote_asset
       ) VALUES ('EQUITIES', 'NASDAQ', $1, $2, 2, 8, 'TRADABLE', 'USD')
       RETURNING id`,
      [symbol, symbol.toLowerCase()],
    );
    await client.query('COMMIT');
    return { userId, accountId, instrumentId: required(instrument.rows[0]?.id) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function required(value: string | undefined): string {
  if (!value) throw new Error('insert returned no id');
  return value;
}
