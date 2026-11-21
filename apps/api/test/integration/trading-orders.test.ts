import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { PoolClient } from 'pg';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiPackageRoot } from '../../src/config/paths.js';
import { migrateUp } from '../../src/infrastructure/db/migrator.js';
import { Phase2Orders } from '../../src/modules/trading/phase2-orders.js';
import type {
  RiskAuthorizer,
  RiskDecision,
  SessionCalendar,
} from '../../src/modules/trading/risk-authorizer.js';
import { type TradingLock, tryHoldSingleton } from '../../src/modules/trading/singleton.js';
import {
  type ExecutableQuote,
  type OrderInput,
  TradingService,
} from '../../src/modules/trading/trading-service.js';
import { startServer } from '../../src/server.js';
import { validEnv } from '../valid-env.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a database whose name ends with _test');
if (!new URL(databaseUrl).pathname.replace(/^\//, '').endsWith('_test')) {
  throw new Error(
    'Refusing to run integration tests against a database whose name does not end with _test',
  );
}

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

function quote(overrides: Partial<ExecutableQuote> = {}): ExecutableQuote {
  return {
    quoteUpdateId: '100',
    bid: '10.00',
    ask: '10.00',
    bidSize: '5.00000000',
    askSize: '5.00000000',
    receivedAt: new Date('2026-11-21T15:00:00.000Z'),
    feedState: 'LIVE',
    priceOrigin: 'TEST_FIXTURE',
    ...overrides,
  };
}

function order(
  ids: { accountId: string; userId: string; instrumentId: string },
  overrides: Partial<OrderInput> = {},
): OrderInput {
  return {
    accountId: ids.accountId,
    userId: ids.userId,
    instrumentId: ids.instrumentId,
    clientOrderId: randomUUID(),
    idempotencyKey: randomUUID(),
    side: 'BUY',
    orderType: 'MARKET',
    quantity: '1.00000000',
    limitPrice: null,
    quote: quote(),
    ...overrides,
  };
}

function gated(lock: TradingLock): TradingService {
  return new TradingService(pool, {
    authorizer: new ApprovingRiskAuthorizer(),
    calendar: new OpenEquityCalendar(),
    fillsEnabled: true,
    lock,
  });
}

function engine(fillsEnabled = true, approve = true): TradingService {
  return new TradingService(pool, {
    authorizer: approve ? new ApprovingRiskAuthorizer() : undefined,
    calendar: new OpenEquityCalendar(),
    fillsEnabled,
  });
}

describe('trading orders on postgres', () => {
  beforeAll(async () => {
    await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('fills one equity buy, rejects a second, and allows a buy only after a full close', async () => {
    const ids = await makeAccount('EQUITIES', 'USD');
    const service = engine();
    const first = await service.submit(order(ids));
    expect(first).toMatchObject({
      state: 'FILLED',
      rejectReason: null,
      filledQuantity: '1.00000000',
      cash: '9989.9500',
    });
    const replay = await service.reapplyFill(first.orderId ?? '');
    expect(replay).toEqual({ applied: false, quantity: '1.00000000' });
    const restarted = new TradingService(pool, {
      authorizer: new ApprovingRiskAuthorizer(),
      calendar: new OpenEquityCalendar(),
      fillsEnabled: true,
    });
    expect(await restarted.position(ids.accountId, ids.instrumentId)).toMatchObject({
      quantity: '1.00000000',
      reservedSell: '0.00000000',
      status: 'OPEN',
    });
    const duplicate = await service.submit(order(ids));
    expect(duplicate.rejectReason).toBe('POSITION_ALREADY_OPEN');

    const partial = await service.submit(
      order(ids, { side: 'SELL', quantity: '0.40000000', quote: quote({ quoteUpdateId: '101' }) }),
    );
    expect(partial).toMatchObject({
      state: 'FILLED',
      filledQuantity: '0.40000000',
      cash: '9993.9500',
    });
    const stillOpen = await service.submit(order(ids, { quote: quote({ quoteUpdateId: '102' }) }));
    expect(stillOpen.rejectReason).toBe('POSITION_ALREADY_OPEN');

    const closed = await service.submit(
      order(ids, { side: 'SELL', quantity: '0.60000000', quote: quote({ quoteUpdateId: '103' }) }),
    );
    expect(closed).toMatchObject({ state: 'FILLED', cash: '9999.9500' });
    expect(await service.position(ids.accountId, ids.instrumentId)).toMatchObject({
      quantity: '0.00000000',
      reservedSell: '0.00000000',
      status: 'CLOSED',
    });
    const reopened = await service.submit(order(ids, { quote: quote({ quoteUpdateId: '104' }) }));
    expect(reopened).toMatchObject({ state: 'FILLED', rejectReason: null, cash: '9989.9000' });

    const fills = await pool.query<{ live_market_data: boolean; execution_venue: string }>(
      'SELECT live_market_data, execution_venue FROM executions WHERE account_id = $1',
      [ids.accountId],
    );
    expect(
      fills.rows.every((row) => !row.live_market_data && row.execution_venue === 'K2_SIMULATION'),
    ).toBe(true);
    const outbox = await pool.query<{ posted_at: Date | null }>(
      'SELECT posted_at FROM ledger_outbox WHERE account_id = $1',
      [ids.accountId],
    );
    expect(outbox.rowCount).toBeGreaterThan(0);
    expect(outbox.rows.every((row) => row.posted_at === null)).toBe(true);
  });

  it('accepts exactly one of two parallel buys', async () => {
    const ids = await makeAccount('EQUITIES', 'USD');
    const service = engine();
    const [left, right] = await Promise.all([
      service.submit(order(ids, { quote: quote({ quoteUpdateId: '201' }) })),
      service.submit(order(ids, { quote: quote({ quoteUpdateId: '202' }) })),
    ]);
    const accepted = [left, right].filter((result) => result.rejectReason === null);
    const rejected = [left, right].filter(
      (result) => result.rejectReason === 'POSITION_ALREADY_OPEN',
    );
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const executions = await pool.query('SELECT id FROM executions WHERE account_id = $1', [
      ids.accountId,
    ]);
    expect(executions.rowCount).toBe(1);
  });

  it('rejects crypto through the risk stub, a closed equity session, a stale quote, and a fail-closed authorizer', async () => {
    const equity = await makeAccount('EQUITIES', 'USD');
    const crypto = await makeAccount('CRYPTO', 'USDT');
    const stub = new TradingService(pool, {
      calendar: new OpenEquityCalendar(),
      fillsEnabled: true,
    });
    expect(
      (
        await stub.submit(
          order(crypto, { quote: quote({ receivedAt: new Date(), quoteUpdateId: '250' }) }),
        )
      ).rejectReason,
    ).toBe('TEMPORARILY_UNAVAILABLE');
    const closed = new TradingService(pool, {
      authorizer: new ApprovingRiskAuthorizer(),
      fillsEnabled: true,
    });
    expect((await closed.submit(order(equity))).rejectReason).toBe('CALENDAR_UNCOVERED');
    expect(
      (await engine().submit(order(equity, { quote: quote({ feedState: 'STALE' }) }))).rejectReason,
    ).toBe('FEED_UNAVAILABLE');
    const failClosed = new TradingService(pool, {
      calendar: new OpenEquityCalendar(),
      fillsEnabled: true,
    });
    const denied = await failClosed.submit(order(equity));
    expect(denied.rejectReason).toBe('TEMPORARILY_UNAVAILABLE');
    const disabled = await engine(false).submit(
      order(equity, { quote: quote({ quoteUpdateId: '301' }) }),
    );
    expect(disabled.rejectReason).toBe('EXECUTION_DISABLED');
    const rows = await pool.query('SELECT id FROM executions WHERE account_id = $1', [
      equity.accountId,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it('settles crypto USDT as USD and still rejects equities and a stale crypto feed', async () => {
    const crypto = await makeAccount('CRYPTO', 'USDT');
    const equity = await makeAccount('EQUITIES', 'USD');
    const stub = new TradingService(pool, {
      calendar: new OpenEquityCalendar(),
      fillsEnabled: true,
    });
    const fresh = quote({ receivedAt: new Date(), quoteUpdateId: '801' });
    expect((await stub.submit(order(crypto, { quote: fresh }))).rejectReason).toBe(
      'TEMPORARILY_UNAVAILABLE',
    );
    expect(
      (
        await stub.submit(
          order(crypto, {
            orderType: 'LIMIT',
            limitPrice: '12.50',
            quote: quote({ receivedAt: new Date(), quoteUpdateId: '802' }),
          }),
        )
      ).rejectReason,
    ).toBe('TEMPORARILY_UNAVAILABLE');
    const phase2 = new Phase2Orders(pool, stub, null, true);
    const placed = await phase2.placeStop({
      accountId: crypto.accountId,
      userId: crypto.userId,
      instrumentId: crypto.instrumentId,
      clientOrderId: randomUUID(),
      idempotencyKey: randomUUID(),
      quantity: '1.00000000',
      triggerPrice: '10.00',
      quote: fresh,
    });
    expect(placed.state).toBe('PENDING');
    await phase2.onQuote(
      crypto.instrumentId,
      quote({ ask: '11.00', bid: '10.90', receivedAt: new Date(), quoteUpdateId: '803' }),
    );
    const triggered = await pool.query<{ reject_reason: string }>(
      `SELECT reject_reason FROM orders
        WHERE account_id = $1 AND client_order_id LIKE 'stop-%'`,
      [crypto.accountId],
    );
    expect(triggered.rows.map((row) => row.reject_reason)).toEqual(['TEMPORARILY_UNAVAILABLE']);

    const approved = new TradingService(pool, {
      authorizer: new ApprovingRiskAuthorizer(),
      fillsEnabled: true,
    });
    const other = await makeAccount('CRYPTO', 'USDT');
    const filled = await approved.submit(
      order(other, {
        quantity: '2.00000000',
        quote: quote({
          bid: '12.40',
          ask: '12.50',
          receivedAt: new Date(),
          quoteUpdateId: '804',
        }),
      }),
    );
    expect(filled).toMatchObject({
      state: 'FILLED',
      rejectReason: null,
      filledQuantity: '2.00000000',
      cash: '9974.8750',
    });
    const execution = await pool.query<{ price: string; notional: string; commission: string }>(
      `SELECT price::text, notional::text, commission::text
         FROM executions WHERE account_id = $1`,
      [other.accountId],
    );
    expect(execution.rows[0]).toEqual({
      price: '12.50000000',
      notional: '25.0000',
      commission: '0.1250',
    });

    expect((await approved.submit(order(equity))).rejectReason).toBe('CALENDAR_UNCOVERED');
    expect(
      (
        await approved.submit(
          order(other, {
            quote: quote({ feedState: 'STALE', receivedAt: new Date(), quoteUpdateId: '805' }),
          }),
        )
      ).rejectReason,
    ).toBe('FEED_UNAVAILABLE');
    expect(
      (
        await approved.submit(
          order(other, {
            quote: quote({
              feedState: 'DISCONNECTED',
              receivedAt: new Date(),
              quoteUpdateId: '806',
            }),
          }),
        )
      ).rejectReason,
    ).toBe('FEED_UNAVAILABLE');
    expect(
      (
        await approved.submit(
          order(other, {
            quote: quote({
              receivedAt: new Date(Date.now() - 6_000),
              quoteUpdateId: '807',
            }),
          }),
        )
      ).rejectReason,
    ).toBe('FEED_UNAVAILABLE');
    const scope = await pool.query(
      `SELECT 1 FROM commission_market_scopes
        WHERE market = 'CRYPTO' AND decision_ref = 'D-CRYPTO-USDT-20261121'`,
    );
    expect(scope.rowCount).toBe(1);
  });

  it('keeps a resting remainder reserved after a partial limit fill', async () => {
    const ids = await makeAccount('EQUITIES', 'USD');
    const result = await engine().submit(
      order(ids, {
        orderType: 'LIMIT',
        quantity: '2.00000000',
        limitPrice: '10.00',
        quote: quote({ askSize: '0.50000000', quoteUpdateId: '401' }),
      }),
    );
    expect(result).toMatchObject({
      state: 'PARTIALLY_FILLED',
      filledQuantity: '0.50000000',
      cash: '9994.9750',
    });
    const reserved = await pool.query<{ reserved_cash: string; cash_reserved: string }>(
      `SELECT projections.reserved_cash::text, orders.cash_reserved::text
       FROM simulation_cash_projections AS projections
       JOIN orders ON orders.account_id = projections.account_id
       WHERE orders.id = $1`,
      [result.orderId],
    );
    expect(reserved.rows[0]).toEqual({ reserved_cash: '15.0750', cash_reserved: '15.0750' });
  });

  it('returns the same order when the idempotency key is repeated', async () => {
    const ids = await makeAccount('EQUITIES', 'USD');
    const input = order(ids, { quote: quote({ quoteUpdateId: '501' }) });
    const service = engine();
    const first = await service.submit(input);
    const second = await service.submit(input);
    expect(second).toEqual(first);
    const executions = await pool.query('SELECT id FROM executions WHERE order_id = $1', [
      first.orderId,
    ]);
    expect(executions.rowCount).toBe(1);
  });

  it('shares 0.5 of ask liquidity across ten buyers and does not refill it', async () => {
    const first = await makeAccount('EQUITIES', 'USD');
    const ids = [first];
    for (let index = 0; index < 9; index += 1) {
      ids.push(await makeAccount('EQUITIES', 'USD', first.instrumentId));
    }
    const shared = quote({ askSize: '0.50000000', quoteUpdateId: '900' });
    const service = engine();
    const results = await Promise.all(
      ids.map((id) => service.submit(order(id, { quote: shared }))),
    );
    expect(results.filter((result) => result.rejectReason === null)).toHaveLength(1);
    const extra = await makeAccount('EQUITIES', 'USD', first.instrumentId);
    const again = await service.submit(order(extra, { quote: shared }));
    expect(again.rejectReason).toBe('NO_LIQUIDITY');
    const stale = await service.submit(
      order(await makeAccount('EQUITIES', 'USD', first.instrumentId), {
        quote: quote({ askSize: '5.00000000', quoteUpdateId: '899' }),
      }),
    );
    expect(stale.rejectReason).toBe('NO_LIQUIDITY');
    const restarted = engine();
    const afterRestart = await restarted.submit(
      order(await makeAccount('EQUITIES', 'USD', first.instrumentId), { quote: shared }),
    );
    expect(afterRestart.rejectReason).toBe('NO_LIQUIDITY');
    const total = await pool.query<{ qty: string }>(
      `SELECT COALESCE(SUM(quantity), 0)::text AS qty FROM executions WHERE instrument_id = $1`,
      [first.instrumentId],
    );
    expect(total.rows[0]?.qty).toBe('0.50000000');
  });

  it('keeps earlier consumption when a price leaves and comes back', async () => {
    const ids = await makeAccount('EQUITIES', 'USD');
    const service = engine();
    const first = await service.submit(
      order(ids, {
        quantity: '0.20000000',
        quote: quote({ ask: '10.00', askSize: '1.00000000', quoteUpdateId: '1' }),
      }),
    );
    expect(first.filledQuantity).toBe('0.20000000');
    await service.submit(
      order(await makeAccount('EQUITIES', 'USD', ids.instrumentId), {
        quantity: '0.10000000',
        quote: quote({ ask: '11.00', askSize: '1.00000000', quoteUpdateId: '2' }),
      }),
    );
    const returned = await service.submit(
      order(await makeAccount('EQUITIES', 'USD', ids.instrumentId), {
        quantity: '1.00000000',
        quote: quote({ ask: '10.00', askSize: '0.50000000', quoteUpdateId: '3' }),
      }),
    );
    expect(returned.filledQuantity).toBe('0.30000000');
    expect(returned.state).toBe('CANCELLED');
  });

  it('rebuilds the working queue from persisted accept sequence', async () => {
    const ids = await makeAccount('EQUITIES', 'USD');
    const service = engine();
    await service.submit(
      order(ids, {
        orderType: 'LIMIT',
        limitPrice: '9.00',
        quote: quote({ ask: '10.00', quoteUpdateId: '50' }),
      }),
    );
    const second = await makeAccount('EQUITIES', 'USD', ids.instrumentId);
    await service.submit(
      order(second, {
        orderType: 'LIMIT',
        limitPrice: '9.00',
        quote: quote({ ask: '10.00', quoteUpdateId: '51' }),
      }),
    );
    const before = await pool.query<{ accept_sequence: string }>(
      `SELECT accept_sequence::text FROM orders
       WHERE instrument_id = $1 AND state = 'OPEN'
       ORDER BY accept_sequence`,
      [ids.instrumentId],
    );
    expect(before.rowCount).toBe(2);
    const restarted = engine();
    await restarted.position(ids.accountId, ids.instrumentId);
    const after = await pool.query<{ accept_sequence: string }>(
      `SELECT accept_sequence::text FROM orders
       WHERE instrument_id = $1 AND state = 'OPEN'
       ORDER BY accept_sequence`,
      [ids.instrumentId],
    );
    expect(after.rows.map((row) => row.accept_sequence)).toEqual(
      before.rows.map((row) => row.accept_sequence),
    );
  });

  it('fills resting orders in accept sequence and does not let a later buy jump ahead', async () => {
    const first = await makeAccount('EQUITIES', 'USD');
    const second = await makeAccount('EQUITIES', 'USD', first.instrumentId);
    const third = await makeAccount('EQUITIES', 'USD', first.instrumentId);
    const service = engine();
    const resting = quote({ ask: '11.00', askSize: '5.00000000' });
    await service.submit(
      order(first, {
        orderType: 'LIMIT',
        limitPrice: '10.00',
        quote: quote({ ...resting, quoteUpdateId: '710' }),
      }),
    );
    await service.submit(
      order(second, {
        orderType: 'LIMIT',
        limitPrice: '10.00',
        quote: quote({ ...resting, quoteUpdateId: '711' }),
      }),
    );
    const walked = await service.applyQuote(
      first.instrumentId,
      quote({ ask: '10.00', askSize: '0.50000000', quoteUpdateId: '720' }),
    );
    expect(walked).toHaveLength(1);
    const quantities = await pool.query<{ client_order_id: string; filled_quantity: string }>(
      `SELECT client_order_id, filled_quantity::text
       FROM orders WHERE instrument_id = $1 AND side = 'BUY'
       ORDER BY accept_sequence`,
      [first.instrumentId],
    );
    expect(quantities.rows.map((row) => row.filled_quantity)).toEqual(['0.50000000', '0.00000000']);

    const later = await service.submit(
      order(third, {
        quote: quote({ ask: '10.00', askSize: '1.00000000', quoteUpdateId: '730' }),
      }),
    );
    expect(later.rejectReason).toBe('NO_LIQUIDITY');
    const after = await pool.query<{ filled_quantity: string }>(
      `SELECT filled_quantity::text FROM orders
       WHERE instrument_id = $1 AND side = 'BUY'
       ORDER BY accept_sequence`,
      [first.instrumentId],
    );
    expect(after.rows.map((row) => row.filled_quantity)).toEqual([
      '1.00000000',
      '0.00000000',
      '0.00000000',
    ]);
  });

  it('stops fills when the process does not hold the trading lock', async () => {
    const env = validEnv({
      DATABASE_URL: databaseUrl,
      PORT: '0',
      HOST: '127.0.0.1',
    }) as NodeJS.ProcessEnv;
    const first = await startServer(env);
    const second = await startServer(env);
    try {
      const firstAddress = first.app.server.address();
      const secondAddress = second.app.server.address();
      const firstPort = typeof firstAddress === 'object' && firstAddress ? firstAddress.port : 0;
      const secondPort =
        typeof secondAddress === 'object' && secondAddress ? secondAddress.port : 0;
      const held = (await (await fetch(`http://127.0.0.1:${firstPort}/health`)).json()) as {
        status: string;
        checks: { tradingLock: { status: string } };
      };
      const blocked = (await (await fetch(`http://127.0.0.1:${secondPort}/health`)).json()) as {
        status: string;
        checks: { tradingLock: { status: string } };
      };
      expect(held).toMatchObject({
        status: 'ok',
        checks: { tradingLock: { status: 'held' } },
      });
      expect(blocked).toMatchObject({
        status: 'degraded',
        checks: { tradingLock: { status: 'unavailable' } },
      });
      const ids = await makeAccount('EQUITIES', 'USD');
      const primary = gated(first.tradingLock);
      const other = gated(second.tradingLock);
      const filled = await primary.submit(order(ids, { quote: quote({ quoteUpdateId: '810' }) }));
      expect(filled.rejectReason).toBeNull();
      const denied = await other.submit(
        order(await makeAccount('EQUITIES', 'USD', ids.instrumentId), {
          quote: quote({ quoteUpdateId: '811' }),
        }),
      );
      expect(denied.rejectReason).toBe('TRADING_LOCK_LOST');
      await first.tradingLock.drop();
      const dropped = (await (await fetch(`http://127.0.0.1:${firstPort}/health`)).json()) as {
        checks: { tradingLock: { status: string } };
      };
      expect(dropped.checks.tradingLock.status).toBe('lost');
      const stopped = await primary.submit(
        order(await makeAccount('EQUITIES', 'USD', ids.instrumentId), {
          quote: quote({ quoteUpdateId: '812' }),
        }),
      );
      expect(stopped.rejectReason).toBe('TRADING_LOCK_LOST');
    } finally {
      await first.app.close();
      await second.app.close();
    }
  });

  it('lets only one dedicated connection hold the trading lock', async () => {
    const url = databaseUrl;
    const holder = await tryHoldSingleton(url);
    expect(holder).not.toBeNull();
    expect(await tryHoldSingleton(url)).toBeNull();
    await holder?.end();
    const next = await tryHoldSingleton(url);
    expect(next).not.toBeNull();
    await next?.end();
  });

  it('rejects a second working buy and a buy against an open position in the database', async () => {
    const ids = await makeAccount('EQUITIES', 'USD');
    const client = await pool.connect();
    try {
      await insertWorkingBuy(client, ids, 'working-a');
      await expect(insertWorkingBuy(client, ids, 'working-b')).rejects.toThrow(
        /orders_one_working_buy_idx|duplicate key/,
      );
      await client.query(`UPDATE orders SET state = 'CANCELLED' WHERE account_id = $1`, [
        ids.accountId,
      ]);
      await client.query(
        `INSERT INTO positions (account_id, instrument_id, status, quantity)
         VALUES ($1, $2, 'OPEN', 1)`,
        [ids.accountId, ids.instrumentId],
      );
      await expect(insertWorkingBuy(client, ids, 'working-c')).rejects.toThrow(
        /POSITION_ALREADY_OPEN/,
      );
    } finally {
      client.release();
    }
  });
});

async function insertWorkingBuy(
  client: PoolClient,
  ids: { accountId: string; userId: string; instrumentId: string },
  clientOrderId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO orders (
       account_id, user_id, instrument_id, client_order_id, side, order_type, state,
       quantity, quote_asset, price_origin, live_market_data, feed_state
     ) VALUES ($1, $2, $3, $4, 'BUY', 'LIMIT', 'OPEN', 1, 'USD', 'TEST_FIXTURE', false, 'LIVE')`,
    [ids.accountId, ids.userId, ids.instrumentId, clientOrderId],
  );
}

async function makeAccount(
  market: 'EQUITIES' | 'CRYPTO',
  quoteAsset: string,
  existingInstrumentId?: string,
): Promise<{
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
      [`trader-${suffix}@example.com`],
    );
    const userId = requiredId(user.rows[0]?.id);
    const picked = 20000 + (Number.parseInt(suffix.slice(0, 4), 16) % 700000);
    const size = (picked === 300000 ? 300001 : picked).toFixed(4);
    const product = await client.query<{ id: string }>(
      `INSERT INTO challenge_products (account_size, currency, active)
       VALUES ($1, 'USD', true) RETURNING id`,
      [size],
    );
    const productId = requiredId(product.rows[0]?.id);
    const price = await client.query<{ id: string }>(
      `INSERT INTO product_price_versions (product_id, price, currency, valid_from, decision_ref)
       VALUES ($1, 100, 'USD', now(), $2) RETURNING id`,
      [productId, `P-${suffix}`.slice(0, 64)],
    );
    const priceId = requiredId(price.rows[0]?.id);
    const rules = await client.query<{ id: string }>(
      `INSERT INTO rule_sets (code, account_type) VALUES ($1, 'CHALLENGE') RETURNING id`,
      [`RULE_${suffix}`.slice(0, 40).toUpperCase()],
    );
    const ruleSetId = requiredId(rules.rows[0]?.id);
    const version = await client.query<{ id: string }>(
      `INSERT INTO rule_set_versions (rule_set_id, version_number, decision_ref, published_at)
       VALUES ($1, 1, $2, now()) RETURNING id`,
      [ruleSetId, `R-${suffix}`.slice(0, 64)],
    );
    const versionId = requiredId(version.rows[0]?.id);
    await client.query(
      `INSERT INTO commission_market_scopes (rule_set_version_id, market, decision_ref)
       VALUES ($1, $2, $3)`,
      [versionId, market, `C-${suffix}`.slice(0, 64)],
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
      [userId, productId, priceId, versionId, requiredId(evidence.rows[0]?.id)],
    );
    const accountId = requiredId(account.rows[0]?.id);
    await client.query(
      `INSERT INTO account_state_transitions (
         account_id, from_state, to_state, reason_code, reason, actor_type, idempotency_key
       ) VALUES ($1, 'PROVISIONED', 'ACTIVE', 'SYSTEM_ACTIVATE', 'test activation for trading', 'SYSTEM', $2)`,
      [accountId, `activate-${suffix}`],
    );
    await client.query(`UPDATE trading_accounts SET state = 'ACTIVE' WHERE id = $1`, [accountId]);
    let instrumentId = existingInstrumentId;
    if (!instrumentId) {
      const symbol = `${market === 'EQUITIES' ? 'EQ' : 'CR'}${suffix}`.slice(0, 20).toUpperCase();
      const instrument = await client.query<{ id: string }>(
        `INSERT INTO instruments (
           market, venue, symbol, provider_symbol, price_scale, quantity_scale, trading_status, quote_asset
         ) VALUES ($1, $2, $3, $4, 2, 8, 'TRADABLE', $5)
         RETURNING id`,
        [
          market,
          market === 'EQUITIES' ? 'NASDAQ' : 'BINANCE_SPOT',
          symbol,
          symbol.toLowerCase(),
          quoteAsset,
        ],
      );
      instrumentId = requiredId(instrument.rows[0]?.id);
    }
    await client.query('COMMIT');
    return { userId, accountId, instrumentId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function requiredId(value: string | undefined): string {
  if (!value) throw new Error('insert returned no id');
  return value;
}
