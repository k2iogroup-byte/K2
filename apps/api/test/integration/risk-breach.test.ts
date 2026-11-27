import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { PoolClient } from 'pg';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiPackageRoot } from '../../src/config/paths.js';
import { migrateUp } from '../../src/infrastructure/db/migrator.js';
import { settleAccount } from '../../src/modules/risk/breach.js';
import { Phase2Orders } from '../../src/modules/trading/phase2-orders.js';
import type { SessionCalendar } from '../../src/modules/trading/risk-authorizer.js';
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

class OpenEquityCalendar implements SessionCalendar {
  equitySessionOpen(): boolean {
    return true;
  }
}

describe('risk breach on postgres', () => {
  beforeAll(async () => {
    await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('force-closes and fails an account when equity touches the daily floor', async () => {
    const ids = await makeAccount();
    await pool.query(
      `INSERT INTO simulation_cash_projections (account_id, cash) VALUES ($1, 90000)`,
      [ids.accountId],
    );
    await pool.query(
      `INSERT INTO positions (account_id, instrument_id, status, quantity, average_entry, opened_at)
       VALUES ($1, $2, 'OPEN', 1500, 10, now())`,
      [ids.accountId, ids.instrumentId],
    );
    await snapshot(ids.instrumentId, '10', '10');
    const trading = new TradingService(pool, {
      calendar: new OpenEquityCalendar(),
      fillsEnabled: true,
    });
    const phase2 = new Phase2Orders(pool, trading, null, true);
    await phase2.onQuote(ids.instrumentId, quote('10', '10.00', 'LIVE'));
    const marked = await pool.query<{ mark: string; state: string }>(
      `SELECT marks.mark::text AS mark, accounts.state
       FROM risk_day_marks AS marks
       JOIN trading_accounts AS accounts ON accounts.id = marks.account_id
       WHERE marks.account_id = $1`,
      [ids.accountId],
    );
    expect(marked.rows).toEqual([{ mark: '105000.0000', state: 'ACTIVE' }]);

    await pool.query(`UPDATE quote_snapshots SET bid = 6.5, ask = 6.5 WHERE instrument_id = $1`, [
      ids.instrumentId,
    ]);
    await phase2.onQuote(ids.instrumentId, quote('11', '6.50', 'LIVE'));
    const breach = await pool.query<{ kind: string; floor: string; state: string; status: string }>(
      `SELECT breaches.kind, breaches.floor::text AS floor, accounts.state, positions.status
       FROM risk_breaches AS breaches
       JOIN trading_accounts AS accounts ON accounts.id = breaches.account_id
       JOIN positions ON positions.account_id = accounts.id
       WHERE breaches.account_id = $1`,
      [ids.accountId],
    );
    expect(breach.rows).toEqual([
      { kind: 'DAILY', floor: '99750.0000', state: 'FAILED', status: 'CLOSED' },
    ]);
    const sells = await pool.query(
      `SELECT id FROM orders WHERE account_id = $1 AND side = 'SELL' AND state = 'FILLED'`,
      [ids.accountId],
    );
    expect(sells.rowCount).toBe(1);
  });

  it('force-closes a drawdown breach when the calendar is closed and the feed is stale', async () => {
    const ids = await makeAccount();
    await pool.query(
      `INSERT INTO simulation_cash_projections (account_id, cash) VALUES ($1, 80000)`,
      [ids.accountId],
    );
    await pool.query(
      `INSERT INTO positions (account_id, instrument_id, status, quantity, average_entry, opened_at)
       VALUES ($1, $2, 'OPEN', 1000, 10, now())`,
      [ids.accountId, ids.instrumentId],
    );
    await snapshot(ids.instrumentId, '12', '12', 'STALE');
    const trading = new TradingService(pool, { fillsEnabled: true });
    const phase2 = new Phase2Orders(pool, trading, null, true);
    await phase2.onQuote(ids.instrumentId, quote('20', '12.00', 'STALE'));
    const row = await pool.query<{ kind: string; floor: string; state: string; status: string }>(
      `SELECT breaches.kind, breaches.floor::text AS floor, accounts.state, positions.status
       FROM risk_breaches AS breaches
       JOIN trading_accounts AS accounts ON accounts.id = breaches.account_id
       JOIN positions ON positions.account_id = accounts.id
       WHERE breaches.account_id = $1`,
      [ids.accountId],
    );
    expect(row.rows).toEqual([
      { kind: 'DRAWDOWN', floor: '92000.0000', state: 'FAILED', status: 'CLOSED' },
    ]);
    const sell = await pool.query<{ reject_reason: string | null }>(
      `SELECT reject_reason FROM orders WHERE account_id = $1 AND side = 'SELL'`,
      [ids.accountId],
    );
    expect(sell.rows).toEqual([{ reject_reason: null }]);
  });

  it('retries a breach close that could not fill and then fills it once', async () => {
    const ids = await makeAccount();
    await pool.query(
      `INSERT INTO simulation_cash_projections (account_id, cash) VALUES ($1, 80000)`,
      [ids.accountId],
    );
    await pool.query(
      `INSERT INTO positions (account_id, instrument_id, status, quantity, average_entry, opened_at)
       VALUES ($1, $2, 'OPEN', 1000, 10, now())`,
      [ids.accountId, ids.instrumentId],
    );
    const blocked = new TradingService(pool, { fillsEnabled: false });
    await withClient((client) =>
      settleAccount(client, blocked, ids.accountId, {
        instrumentId: ids.instrumentId,
        bid: '12.00',
        quote: quote('30', '12.00', 'STALE'),
      }),
    );
    const waiting = await pool.query<{ state: string; status: string; resolved: number }>(
      `SELECT accounts.state, positions.status,
              (SELECT count(*) FROM risk_close_resolutions AS resolutions
                 JOIN risk_close_attempts AS attempts ON attempts.id = resolutions.attempt_id
                WHERE attempts.breach_id = breaches.id)::int AS resolved
       FROM trading_accounts AS accounts
       JOIN positions ON positions.account_id = accounts.id
       JOIN risk_breaches AS breaches ON breaches.account_id = accounts.id
       WHERE accounts.id = $1`,
      [ids.accountId],
    );
    expect(waiting.rows).toEqual([{ state: 'FAILED', status: 'OPEN', resolved: 0 }]);

    const trading = new TradingService(pool, { fillsEnabled: true });
    await withClient((client) =>
      settleAccount(client, trading, ids.accountId, {
        instrumentId: ids.instrumentId,
        bid: '12.00',
        quote: quote('31', '12.00', 'STALE'),
      }),
    );
    const closed = await pool.query<{ status: string; outcome: string }>(
      `SELECT positions.status, resolutions.outcome
       FROM positions
       JOIN risk_close_attempts AS attempts ON attempts.position_id = positions.id
       JOIN risk_close_resolutions AS resolutions ON resolutions.attempt_id = attempts.id
       WHERE positions.account_id = $1`,
      [ids.accountId],
    );
    expect(closed.rows).toEqual([{ status: 'CLOSED', outcome: 'FILLED' }]);
    const sells = await pool.query(
      `SELECT id FROM orders WHERE account_id = $1 AND side = 'SELL' AND state = 'FILLED'`,
      [ids.accountId],
    );
    expect(sells.rowCount).toBe(1);
  });

  it('lets two simultaneous breaching quotes force-close a position once', async () => {
    const ids = await makeAccount();
    await pool.query(
      `INSERT INTO simulation_cash_projections (account_id, cash) VALUES ($1, 80000)`,
      [ids.accountId],
    );
    await pool.query(
      `INSERT INTO positions (account_id, instrument_id, status, quantity, average_entry, opened_at)
       VALUES ($1, $2, 'OPEN', 1000, 10, now())`,
      [ids.accountId, ids.instrumentId],
    );
    const trading = new TradingService(pool, { fillsEnabled: true });
    await Promise.all([
      withClient((client) =>
        settleAccount(client, trading, ids.accountId, {
          instrumentId: ids.instrumentId,
          bid: '12.00',
          quote: quote('40', '12.00', 'LIVE'),
        }),
      ),
      withClient((client) =>
        settleAccount(client, trading, ids.accountId, {
          instrumentId: ids.instrumentId,
          bid: '12.00',
          quote: quote('41', '12.00', 'LIVE'),
        }),
      ),
    ]);
    const breaches = await pool.query(`SELECT id FROM risk_breaches WHERE account_id = $1`, [
      ids.accountId,
    ]);
    const sells = await pool.query(
      `SELECT id FROM orders WHERE account_id = $1 AND side = 'SELL' AND state = 'FILLED'`,
      [ids.accountId],
    );
    expect(breaches.rowCount).toBe(1);
    expect(sells.rowCount).toBe(1);
  });

  it('does not sell again when a deferred close already reserved the position', async () => {
    const ids = await makeAccount();
    await pool.query(
      `INSERT INTO simulation_cash_projections (account_id, cash) VALUES ($1, 80000)`,
      [ids.accountId],
    );
    const position = await pool.query<{ id: string }>(
      `INSERT INTO positions (
         account_id, instrument_id, status, quantity, reserved_sell, average_entry, opened_at
       ) VALUES ($1, $2, 'OPEN', 1000, 1000, 10, now())
       RETURNING id`,
      [ids.accountId, ids.instrumentId],
    );
    const positionId = position.rows[0]?.id ?? '';
    const order = await pool.query<{ id: string }>(
      `INSERT INTO orders (
         account_id, user_id, instrument_id, client_order_id, side, order_type, state,
         quantity, sell_reserved, quote_asset, price_origin, live_market_data, feed_state
       ) VALUES ($1, $2, $3, $4, 'SELL', 'MARKET', 'OPEN', 1000, 1000, 'USD', 'TEST_FIXTURE', false, 'LIVE')
       RETURNING id`,
      [ids.accountId, ids.userId, ids.instrumentId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO deferred_closes (order_id, position_id, account_id, instrument_id, quantity)
       VALUES ($1, $2, $3, $4, 1000)`,
      [order.rows[0]?.id, positionId, ids.accountId, ids.instrumentId],
    );
    const trading = new TradingService(pool, { fillsEnabled: true });
    await withClient((client) =>
      settleAccount(client, trading, ids.accountId, {
        instrumentId: ids.instrumentId,
        bid: '12.00',
        quote: quote('50', '12.00', 'STALE'),
      }),
    );
    const linked = await pool.query<{ order_id: string; state: string }>(
      `SELECT attempts.order_id, accounts.state
       FROM risk_close_attempts AS attempts
       JOIN risk_breaches AS breaches ON breaches.id = attempts.breach_id
       JOIN trading_accounts AS accounts ON accounts.id = breaches.account_id
       WHERE breaches.account_id = $1`,
      [ids.accountId],
    );
    expect(linked.rows).toEqual([{ order_id: order.rows[0]?.id, state: 'FAILED' }]);
    const sells = await pool.query(
      `SELECT id FROM orders WHERE account_id = $1 AND side = 'SELL'`,
      [ids.accountId],
    );
    expect(sells.rowCount).toBe(1);
  });
});

function quote(
  updateId: string,
  bid: string,
  feedState: ExecutableQuote['feedState'],
): ExecutableQuote {
  return {
    quoteUpdateId: updateId,
    bid,
    ask: bid,
    bidSize: '100000.00000000',
    askSize: '100000.00000000',
    receivedAt: new Date('2026-11-21T15:00:00.000Z'),
    feedState,
    priceOrigin: 'TEST_FIXTURE',
  };
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

async function snapshot(
  instrumentId: string,
  bid: string,
  ask: string,
  feed = 'LIVE',
): Promise<void> {
  await pool.query(
    `INSERT INTO quote_snapshots (
       instrument_id, bid, ask, bid_size, ask_size, source_timestamp, received_timestamp,
       processed_timestamp, sequence_no, provider_event_id, price_origin, feed_state
     ) VALUES ($1, $2, $3, 100000, 100000, now(), now(), now(), 1, '1', 'TEST_FIXTURE', $4)`,
    [instrumentId, bid, ask, feed],
  );
}

async function makeAccount(): Promise<{ userId: string; accountId: string; instrumentId: string }> {
  const client = await pool.connect();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>(
      'INSERT INTO users (email) VALUES ($1) RETURNING id',
      [`breach-${suffix}@example.com`],
    );
    const userId = required(user.rows[0]?.id);
    const picked = 21000 + (Number.parseInt(suffix.slice(0, 4), 16) % 700000);
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
    const symbol = `BR${suffix}`.slice(0, 20).toUpperCase();
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
