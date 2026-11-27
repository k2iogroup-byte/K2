import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { PoolClient } from 'pg';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiPackageRoot } from '../../src/config/paths.js';
import { migrateUp } from '../../src/infrastructure/db/migrator.js';
import { evaluateProgress } from '../../src/modules/risk/stage.js';
import type { ExecutableQuote } from '../../src/modules/trading/trading-service.js';
import { TradingService } from '../../src/modules/trading/trading-service.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a database whose name ends with _test');
if (!new URL(databaseUrl).pathname.replace(/^\//, '').endsWith('_test')) {
  throw new Error(
    'Refusing to run integration tests against a database whose name does not end with _test',
  );
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

describe('stage outcome on postgres', () => {
  beforeAll(async () => {
    await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('records a stage 1 pass without opening another account', async () => {
    const ids = await makeAccount();
    await pool.query(
      `INSERT INTO simulation_cash_projections (account_id, cash) VALUES ($1, 108000)`,
      [ids.accountId],
    );
    await insertExecutions(ids, [
      '2026-11-01T00:00:00.000Z',
      '2026-11-02T00:00:00.000Z',
      '2026-11-03T00:00:00.000Z',
      '2026-11-04T00:00:00.000Z',
      '2026-11-05T00:00:00.000Z',
      '2026-11-06T00:00:00.000Z',
      '2026-11-07T00:00:00.000Z',
    ]);
    const before = await pool.query(`SELECT id FROM trading_accounts`);
    const trading = new TradingService(pool, { fillsEnabled: true });
    await withClient((client) =>
      evaluateProgress(client, trading, ids.accountId, new Date('2026-11-20T00:00:00.000Z')),
    );
    await withClient((client) =>
      evaluateProgress(client, trading, ids.accountId, new Date('2026-11-20T00:00:00.000Z')),
    );
    const after = await pool.query(`SELECT id FROM trading_accounts`);
    expect(after.rowCount).toBe(before.rowCount);
    const outcome = await pool.query<{ state: string; outcome: string; reason: string }>(
      `SELECT accounts.state, outcomes.outcome, outcomes.reason
       FROM trading_accounts AS accounts
       JOIN risk_stage_outcomes AS outcomes ON outcomes.account_id = accounts.id
       WHERE accounts.id = $1`,
      [ids.accountId],
    );
    expect(outcome.rows).toEqual([{ state: 'PASSED', outcome: 'PASSED', reason: 'STAGE_1' }]);
    const transitions = await pool.query(
      `SELECT id FROM account_state_transitions
       WHERE account_id = $1 AND to_state = 'PASSED'`,
      [ids.accountId],
    );
    expect(transitions.rowCount).toBe(1);
  });

  it('fails a timed-out stage and force-closes the open position', async () => {
    const ids = await makeAccount();
    await pool.query(
      `INSERT INTO simulation_cash_projections (account_id, cash) VALUES ($1, 100000)`,
      [ids.accountId],
    );
    await insertExecutions(ids, ['2026-10-01T00:00:00.000Z']);
    await pool.query(
      `INSERT INTO positions (account_id, instrument_id, status, quantity, average_entry, opened_at)
       VALUES ($1, $2, 'OPEN', 1, 10, now())`,
      [ids.accountId, ids.instrumentId],
    );
    const trading = new TradingService(pool, { fillsEnabled: true });
    await withClient((client) =>
      evaluateProgress(client, trading, ids.accountId, new Date('2026-11-01T00:00:00.000Z'), {
        instrumentId: ids.instrumentId,
        bid: '10.00',
        quote: quote(),
      }),
    );
    const row = await pool.query<{ state: string; kind: string; status: string; outcome: string }>(
      `SELECT accounts.state, breaches.kind, positions.status, resolutions.outcome
       FROM trading_accounts AS accounts
       JOIN risk_breaches AS breaches ON breaches.account_id = accounts.id
       JOIN positions ON positions.account_id = accounts.id
       JOIN risk_close_attempts AS attempts ON attempts.position_id = positions.id
       JOIN risk_close_resolutions AS resolutions ON resolutions.attempt_id = attempts.id
       WHERE accounts.id = $1`,
      [ids.accountId],
    );
    expect(row.rows).toEqual([
      { state: 'FAILED', kind: 'TIMEOUT', status: 'CLOSED', outcome: 'FILLED' },
    ]);
    const accounts = await pool.query(`SELECT id FROM trading_accounts WHERE user_id = $1`, [
      ids.userId,
    ]);
    expect(accounts.rowCount).toBe(1);
  });
});

function quote(): ExecutableQuote {
  return {
    quoteUpdateId: '70',
    bid: '10.00',
    ask: '10.00',
    bidSize: '10.00000000',
    askSize: '10.00000000',
    receivedAt: new Date('2026-11-01T00:00:00.000Z'),
    feedState: 'STALE',
    priceOrigin: 'TEST_FIXTURE',
  };
}

async function insertExecutions(
  ids: { accountId: string; userId: string; instrumentId: string },
  times: readonly string[],
): Promise<void> {
  const order = await pool.query<{ id: string }>(
    `INSERT INTO orders (
       account_id, user_id, instrument_id, client_order_id, side, order_type, state,
       quantity, filled_quantity, quote_asset, price_origin, live_market_data, feed_state
     ) VALUES ($1, $2, $3, $4, 'BUY', 'MARKET', 'FILLED', 1, 1, 'USD', 'TEST_FIXTURE', false, 'LIVE')
     RETURNING id`,
    [ids.accountId, ids.userId, ids.instrumentId, randomUUID()],
  );
  const orderId = order.rows[0]?.id;
  if (!orderId) throw new Error('order insert returned no id');
  for (const [index, time] of times.entries()) {
    await pool.query(
      `INSERT INTO executions (
         order_id, account_id, instrument_id, sequence_no, quantity, price, notional, commission,
         quote_update_id, received_at, executed_at, price_origin, live_market_data, execution_venue
       ) VALUES ($1, $2, $3, $4, 1, 10, 10, 0, $5, $6, $6, 'TEST_FIXTURE', false, 'K2_SIMULATION')`,
      [orderId, ids.accountId, ids.instrumentId, index + 1, String(index + 1), time],
    );
  }
}

async function withClient(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function makeAccount(): Promise<{ userId: string; accountId: string; instrumentId: string }> {
  const client = await pool.connect();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>(
      'INSERT INTO users (email) VALUES ($1) RETURNING id',
      [`stage-${suffix}@example.com`],
    );
    const userId = required(user.rows[0]?.id);
    const picked = 22000 + (Number.parseInt(suffix.slice(0, 4), 16) % 700000);
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
       ) VALUES ($1, 'CHALLENGE', 'STAGE_1', 'PROVISIONED', 100000, 'USD', $2, $3, $4, $5, now())
       RETURNING id`,
      [userId, productId, priceId, versionId, required(evidence.rows[0]?.id)],
    );
    const accountId = required(account.rows[0]?.id);
    await client.query(
      `INSERT INTO account_state_transitions (
         account_id, from_state, to_state, reason_code, reason, actor_type, idempotency_key
       ) VALUES ($1, 'PROVISIONED', 'ACTIVE', 'SYSTEM_ACTIVATE', 'test activation for risk', 'SYSTEM', $2)`,
      [accountId, `activate-${suffix}`],
    );
    await client.query(`UPDATE trading_accounts SET state = 'ACTIVE' WHERE id = $1`, [accountId]);
    const symbol = `ST${suffix}`.slice(0, 20).toUpperCase();
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
