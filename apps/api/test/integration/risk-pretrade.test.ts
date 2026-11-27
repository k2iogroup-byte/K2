import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { PoolClient } from 'pg';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiPackageRoot } from '../../src/config/paths.js';
import { migrateUp } from '../../src/infrastructure/db/migrator.js';
import { RiskEngineAuthorizer } from '../../src/modules/risk/engine.js';
import type { SessionCalendar } from '../../src/modules/trading/risk-authorizer.js';
import {
  type ExecutableQuote,
  type OrderInput,
  TradingService,
} from '../../src/modules/trading/trading-service.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a database whose name ends with _test');
if (!new URL(databaseUrl).pathname.replace(/^\//, '').endsWith('_test')) {
  throw new Error(
    'Refusing to run integration tests against a database whose name does not end with _test',
  );
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const authorizer = new RiskEngineAuthorizer();

class OpenEquityCalendar implements SessionCalendar {
  equitySessionOpen(): boolean {
    return true;
  }
}

describe('risk pre-trade on postgres', () => {
  beforeAll(async () => {
    await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('lifts the daily floor when equity, not closed balance, makes a new high', async () => {
    const ids = await makeAccount('100000.0000');
    await pool.query(
      `INSERT INTO simulation_cash_projections (account_id, cash) VALUES ($1, 100000)`,
      [ids.accountId],
    );
    await pool.query(
      `INSERT INTO positions (account_id, instrument_id, status, quantity, average_entry, opened_at)
       VALUES ($1, $2, 'OPEN', 500, 10, now())`,
      [ids.accountId, ids.instrumentId],
    );
    await snapshot(ids.instrumentId, '10', '10');
    const other = await addInstrument();

    const approved = await decide(ids, other, { quantity: '1.00000000', limitPrice: '11.00' });
    expect(approved.decision).toBe('APPROVE');
    const high = await pool.query<{ mark: string; floors: string; drawdown: string }>(
      `SELECT marks.mark::text AS mark, decisions.daily_floor::text AS floors,
              decisions.drawdown_floor::text AS drawdown
       FROM risk_day_marks AS marks
       JOIN risk_decisions AS decisions ON decisions.account_id = marks.account_id
       WHERE marks.account_id = $1`,
      [ids.accountId],
    );
    expect(high.rows).toEqual([
      { mark: '105000.0000', floors: '99750.0000', drawdown: '92000.0000' },
    ]);
    const cash = await pool.query<{ cash: string }>(
      `SELECT cash::text FROM simulation_cash_projections WHERE account_id = $1`,
      [ids.accountId],
    );
    expect(cash.rows[0]?.cash).toBe('100000.0000');

    const rejected = await decide(ids, other, { quantity: '6000.00000000', limitPrice: '11.00' });
    expect(rejected).toMatchObject({ decision: 'REJECT', reasonCode: 'DAILY_LOSS' });

    await pool.query(`UPDATE quote_snapshots SET bid = 9, ask = 9 WHERE instrument_id = $1`, [
      ids.instrumentId,
    ]);
    await decide(ids, other, { quantity: '1.00000000', limitPrice: '11.00' });
    const unchanged = await pool.query(
      `SELECT mark::text FROM risk_day_marks WHERE account_id = $1`,
      [ids.accountId],
    );
    expect(unchanged.rows).toEqual([{ mark: '105000.0000' }]);

    await pool.query(`UPDATE quote_snapshots SET bid = 12, ask = 12 WHERE instrument_id = $1`, [
      ids.instrumentId,
    ]);
    await decide(ids, other, { quantity: '1.00000000', limitPrice: '11.00' });
    const raised = await pool.query<{ mark: string }>(
      `SELECT mark::text FROM risk_day_marks WHERE account_id = $1 ORDER BY mark`,
      [ids.accountId],
    );
    expect(raised.rows.map((row) => row.mark)).toEqual(['105000.0000', '106000.0000']);
  });

  it('rejects a pre-trade that touches the static drawdown floor', async () => {
    const ids = await makeAccount('100000.0000');
    await pool.query(
      `INSERT INTO simulation_cash_projections (account_id, cash) VALUES ($1, 93000)`,
      [ids.accountId],
    );
    const decision = await decide(ids, ids.instrumentId, {
      quantity: '20000.00000000',
      limitPrice: '10.00',
      bid: '10.00',
      ask: '10.00',
    });
    expect(decision).toMatchObject({ decision: 'REJECT', reasonCode: 'MAX_DRAWDOWN' });
  });

  it('prices a market buy at the ask and an entry stop at the worse of stop and ask', async () => {
    const market = await makeAccount('100000.0000');
    const pricedAtBid = await decide(market, market.instrumentId, {
      orderType: 'MARKET',
      quantity: '1000.00000000',
      bid: '10.00',
      ask: '10.00',
    });
    expect(pricedAtBid.decision).toBe('APPROVE');
    const pricedAtAsk = await decide(market, market.instrumentId, {
      orderType: 'MARKET',
      quantity: '1000.00000000',
      bid: '10.00',
      ask: '15.00',
    });
    expect(pricedAtAsk).toMatchObject({ decision: 'REJECT', reasonCode: 'DAILY_LOSS' });

    const stopped = await makeAccount('100000.0000');
    const resting = await addInstrument();
    await snapshot(resting, '10', '12');
    await pool.query(
      `INSERT INTO conditional_orders (
         account_id, user_id, instrument_id, kind, side, trigger_price, quantity, state, client_order_id
       ) VALUES ($1, $2, $3, 'ENTRY_STOP', 'BUY', 15, 1000, 'PENDING', $4)`,
      [stopped.accountId, stopped.userId, resting, randomUUID()],
    );
    const blocked = await decide(stopped, stopped.instrumentId, {
      quantity: '1.00000000',
      limitPrice: '11.00',
    });
    expect(blocked).toMatchObject({ decision: 'REJECT', reasonCode: 'DAILY_LOSS' });

    const clear = await makeAccount('100000.0000');
    const allowed = await decide(clear, clear.instrumentId, {
      quantity: '1.00000000',
      limitPrice: '11.00',
    });
    expect(allowed.decision).toBe('APPROVE');
  });

  it('does not count a working sell against a new buy', async () => {
    const ids = await makeAccount('100000.0000');
    const sold = await addInstrument();
    await snapshot(sold, '10', '12');
    await pool.query(
      `INSERT INTO orders (
         account_id, user_id, instrument_id, client_order_id, side, order_type, state,
         quantity, limit_price, quote_asset, price_origin, live_market_data, feed_state
       ) VALUES ($1, $2, $3, $4, 'SELL', 'LIMIT', 'OPEN', 3000, 11, 'USD', 'TEST_FIXTURE', false, 'LIVE')`,
      [ids.accountId, ids.userId, sold, randomUUID()],
    );
    const decision = await decide(ids, ids.instrumentId, {
      quantity: '3000.00000000',
      limitPrice: '11.00',
      bid: '10.00',
      ask: '12.00',
    });
    expect(decision.decision).toBe('APPROVE');
  });

  it('rejects the second of two concurrent buys that only pass alone', async () => {
    const ids = await makeAccount('100000.0000');
    const left = await addInstrument();
    const right = await addInstrument();
    await snapshot(left, '10', '12');
    await snapshot(right, '10', '12');
    const service = new TradingService(pool, {
      authorizer,
      calendar: new OpenEquityCalendar(),
      fillsEnabled: true,
    });
    const [first, second] = await Promise.all([
      service.submit(restingBuy(ids, left, '401')),
      service.submit(restingBuy(ids, right, '402')),
    ]);
    const approved = [first, second].filter((result) => result.rejectReason === null);
    const rejected = [first, second].filter((result) => result.rejectReason === 'DAILY_LOSS');
    expect(approved).toHaveLength(1);
    expect(approved[0]).toMatchObject({ state: 'OPEN' });
    expect(rejected).toHaveLength(1);
    const openOrders = await pool.query(
      `SELECT id FROM orders
       WHERE account_id = $1 AND side = 'BUY' AND state = 'OPEN'`,
      [ids.accountId],
    );
    expect(openOrders.rowCount).toBe(1);
    const marks = await pool.query(`SELECT id FROM risk_day_marks WHERE account_id = $1`, [
      ids.accountId,
    ]);
    expect(marks.rowCount).toBe(1);
  });

  it('fails closed when an open position has no bid', async () => {
    const ids = await makeAccount('100000.0000');
    await pool.query(
      `INSERT INTO positions (account_id, instrument_id, status, quantity, opened_at)
       VALUES ($1, $2, 'OPEN', 1, now())`,
      [ids.accountId, ids.instrumentId],
    );
    const decision = await decide(ids, ids.instrumentId, {
      quantity: '1.00000000',
      limitPrice: '11.00',
    });
    expect(decision).toMatchObject({
      decision: 'REJECT',
      reasonCode: 'TEMPORARILY_UNAVAILABLE',
      mode: 'FAIL_CLOSED',
    });
  });
});

function restingBuy(
  ids: { accountId: string; userId: string },
  instrumentId: string,
  updateId: string,
): OrderInput {
  return {
    accountId: ids.accountId,
    userId: ids.userId,
    instrumentId,
    clientOrderId: randomUUID(),
    idempotencyKey: randomUUID(),
    side: 'BUY',
    orderType: 'LIMIT',
    quantity: '3000.00000000',
    limitPrice: '11.00',
    quote: quote(updateId),
  };
}

function quote(updateId: string): ExecutableQuote {
  return {
    quoteUpdateId: updateId,
    bid: '10.00',
    ask: '12.00',
    bidSize: '100000.00000000',
    askSize: '100000.00000000',
    receivedAt: new Date(),
    feedState: 'LIVE',
    priceOrigin: 'TEST_FIXTURE',
  };
}

async function decide(
  ids: { accountId: string },
  instrumentId: string,
  input: {
    quantity: string;
    limitPrice?: string;
    bid?: string;
    ask?: string;
    orderType?: 'MARKET' | 'LIMIT';
  },
) {
  return withClient((client) =>
    authorizer.authorize(
      {
        accountId: ids.accountId,
        instrumentId,
        side: 'BUY',
        quantity: input.quantity,
        orderType: input.orderType ?? 'LIMIT',
        limitPrice: input.limitPrice ?? null,
        bid: input.bid ?? '10.00',
        ask: input.ask ?? '12.00',
      },
      client,
    ),
  );
}

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function snapshot(instrumentId: string, bid: string, ask: string): Promise<void> {
  await pool.query(
    `INSERT INTO quote_snapshots (
       instrument_id, bid, ask, bid_size, ask_size, source_timestamp, received_timestamp,
       processed_timestamp, sequence_no, provider_event_id, price_origin, feed_state
     ) VALUES ($1, $2, $3, 5, 5, now(), now(), now(), 1, $4, 'TEST_FIXTURE', 'LIVE')`,
    [instrumentId, bid, ask, randomUUID()],
  );
}

async function addInstrument(): Promise<string> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const symbol = `RQ${suffix}`.slice(0, 20).toUpperCase();
  const instrument = await pool.query<{ id: string }>(
    `INSERT INTO instruments (
       market, venue, symbol, provider_symbol, price_scale, quantity_scale, trading_status, quote_asset
     ) VALUES ('EQUITIES', 'NASDAQ', $1, $2, 2, 8, 'TRADABLE', 'USD')
     RETURNING id`,
    [symbol, symbol.toLowerCase()],
  );
  const id = instrument.rows[0]?.id;
  if (!id) throw new Error('instrument insert returned no id');
  return id;
}

async function makeAccount(initial: string): Promise<{
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
      [`risk-${suffix}@example.com`],
    );
    const userId = required(user.rows[0]?.id);
    const picked = 20000 + (Number.parseInt(suffix.slice(0, 4), 16) % 700000);
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
       ) VALUES ($1, 'CHALLENGE', 'STAGE_1', 'PROVISIONED', $2, 'USD', $3, $4, $5, $6, now())
       RETURNING id`,
      [userId, initial, productId, priceId, versionId, required(evidence.rows[0]?.id)],
    );
    const accountId = required(account.rows[0]?.id);
    await client.query(
      `INSERT INTO account_state_transitions (
         account_id, from_state, to_state, reason_code, reason, actor_type, idempotency_key
       ) VALUES ($1, 'PROVISIONED', 'ACTIVE', 'SYSTEM_ACTIVATE', 'test activation for risk', 'SYSTEM', $2)`,
      [accountId, `activate-${suffix}`],
    );
    await client.query(`UPDATE trading_accounts SET state = 'ACTIVE' WHERE id = $1`, [accountId]);
    const symbol = `EQ${suffix}`.slice(0, 20).toUpperCase();
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
