import { randomUUID } from 'node:crypto';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiPackageRoot } from '../../src/config/paths.js';
import { migrateUp } from '../../src/infrastructure/db/migrator.js';
import { MarketDataEngine } from '../../src/modules/market-data/engine.js';
import { MarketDataStore } from '../../src/modules/market-data/store.js';
import { closeByPercent } from '../../src/modules/trading/close-position.js';
import { Phase2Orders } from '../../src/modules/trading/phase2-orders.js';
import { protectionHash } from '../../src/modules/trading/protection.js';
import { bindTradingQuotes } from '../../src/modules/trading/quote-bridge.js';
import type { ExecutableQuote } from '../../src/modules/trading/trading-service.js';
import { TradingService } from '../../src/modules/trading/trading-service.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a database whose name ends with _test');

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

function service(): TradingService {
  return new TradingService(pool, { fillsEnabled: true });
}

function quote(updateId: string, bid: string, feed: ExecutableQuote['feedState']): ExecutableQuote {
  return {
    quoteUpdateId: updateId,
    bid,
    ask: '10.20',
    bidSize: '8.00000000',
    askSize: '8.00000000',
    receivedAt: new Date('2026-11-21T16:00:00.000Z'),
    feedState: feed,
    priceOrigin: 'TEST_FIXTURE',
  };
}

describe('risk-reducing closes are not rejected for missing data', () => {
  beforeAll(async () => {
    await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('freezes a close when the feed is disconnected, then fills the fresh bid', async () => {
    const ids = await makeAccount('defer');
    ids.positionId = await openPosition(ids, '2', '10');
    await snapshot(ids.instrumentId, 'DISCONNECTED');
    const trading = service();
    const closed = await closeByPercent(pool, trading, {
      positionId: ids.positionId,
      userId: ids.userId,
      percentage: 100,
      idempotencyKey: `rr-close-${ids.accountId}`,
      requestHash: protectionHash({ positionId: ids.positionId, percentage: 100 }),
      quote: quote('1', '10.00', 'DISCONNECTED'),
    });
    expect(closed).toMatchObject({
      state: 'OPEN',
      rejectReason: null,
      filledQuantity: '0.00000000',
    });
    const frozen = await pool.query<{ quantity: string; reserved_sell: string }>(
      'SELECT quantity::text, reserved_sell::text FROM positions WHERE id = $1',
      [ids.positionId],
    );
    expect(frozen.rows[0]).toMatchObject({ quantity: '2.00000000', reserved_sell: '2.00000000' });
    const replay = await closeByPercent(pool, trading, {
      positionId: ids.positionId,
      userId: ids.userId,
      percentage: 100,
      idempotencyKey: `rr-close-${ids.accountId}`,
      requestHash: protectionHash({ positionId: ids.positionId, percentage: 100 }),
      quote: quote('1', '10.00', 'DISCONNECTED'),
    });
    expect(replay).toEqual(closed);
    await expect(
      closeByPercent(pool, trading, {
        positionId: ids.positionId,
        userId: randomUUID(),
        percentage: 100,
        idempotencyKey: `rr-foreign-${ids.accountId}`,
        requestHash: protectionHash({ positionId: ids.positionId, percentage: 100 }),
        quote: quote('1', '10.00', 'DISCONNECTED'),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    const bought = await trading.submit({
      accountId: ids.accountId,
      userId: ids.userId,
      instrumentId: ids.instrumentId,
      clientOrderId: 'still-buy',
      idempotencyKey: `rr-buy-${ids.accountId}`,
      side: 'BUY',
      orderType: 'MARKET',
      quantity: '1',
      limitPrice: null,
      quote: quote('2', '10.00', 'DISCONNECTED'),
    });
    expect(bought.rejectReason).toBe('CALENDAR_UNCOVERED');

    await freshQuote(ids, trading, '3', '9.50', '9.80');
    const position = await pool.query<{ quantity: string; reserved_sell: string }>(
      'SELECT quantity::text, reserved_sell::text FROM positions WHERE id = $1',
      [ids.positionId],
    );
    expect(position.rows[0]).toMatchObject({ quantity: '0.00000000', reserved_sell: '0.00000000' });
    const fill = await pool.query<{ price: string }>(
      `SELECT price::text FROM executions WHERE account_id = $1`,
      [ids.accountId],
    );
    expect(fill.rows).toHaveLength(1);
    expect(fill.rows[0]?.price.startsWith('9.5')).toBe(true);
    const audit = await pool.query<{ price_basis: string; quote_age_fill_ms: string | null }>(
      `SELECT price_basis, quote_age_fill_ms::text
         FROM risk_reducing_audits WHERE account_id = $1`,
      [ids.accountId],
    );
    expect(audit.rows[0]?.price_basis).toBe('DEFERRED_FRESH');
    expect(audit.rows[0]?.quote_age_fill_ms).not.toBeNull();
  });

  it('fills at the entry price when the instrument has never had a quote', async () => {
    const ids = await makeAccount('entry');
    ids.positionId = await openPosition(ids, '1', '10');
    const result = await closeByPercent(pool, service(), {
      positionId: ids.positionId,
      userId: ids.userId,
      percentage: 100,
      idempotencyKey: `rr-entry-${ids.accountId}`,
      requestHash: protectionHash({ positionId: ids.positionId, percentage: 100 }),
      quote: null,
    });
    expect(result.state).toBe('FILLED');
    const fill = await pool.query<{ price: string }>(
      'SELECT price::text FROM executions WHERE account_id = $1',
      [ids.accountId],
    );
    expect(fill.rows[0]?.price.startsWith('10')).toBe(true);
    const basis = await pool.query<{ price_basis: string }>(
      'SELECT price_basis FROM risk_reducing_audits WHERE account_id = $1',
      [ids.accountId],
    );
    expect(basis.rows[0]?.price_basis).toBe('ENTRY_FALLBACK');
  });

  it('defers a stale stop loss and does not oversell against a frozen close', async () => {
    const ids = await makeAccount('race');
    ids.positionId = await openPosition(ids, '2', '10');
    await snapshot(ids.instrumentId, 'STALE');
    await pool.query(
      `INSERT INTO conditional_orders (
         account_id, user_id, instrument_id, position_id, kind, side, trigger_price, state
       ) VALUES ($1, $2, $3, $4, 'STOP_LOSS', 'SELL', 9, 'PENDING')`,
      [ids.accountId, ids.userId, ids.instrumentId, ids.positionId],
    );
    const trading = service();
    const phase2 = new Phase2Orders(pool, trading, null, true);
    await phase2.onQuote(ids.instrumentId, quote('4', '9.00', 'STALE'));
    const waiting = await pool.query<{ state: string }>(
      `SELECT orders.state FROM deferred_closes
         JOIN orders ON orders.id = deferred_closes.order_id
        WHERE deferred_closes.account_id = $1`,
      [ids.accountId],
    );
    expect(waiting.rows[0]?.state).toBe('OPEN');
    await expect(
      closeByPercent(pool, trading, {
        positionId: ids.positionId,
        userId: ids.userId,
        percentage: 100,
        idempotencyKey: `rr-race-${ids.accountId}`,
        requestHash: protectionHash({ positionId: ids.positionId, percentage: 100 }),
        quote: quote('5', '9.00', 'STALE'),
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await freshQuote(ids, trading, '6', '8.75', '9.00');
    const position = await pool.query<{ quantity: string; reserved_sell: string }>(
      'SELECT quantity::text, reserved_sell::text FROM positions WHERE id = $1',
      [ids.positionId],
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
    const price = await pool.query<{ price: string }>(
      'SELECT price::text FROM executions WHERE account_id = $1',
      [ids.accountId],
    );
    expect(price.rows[0]?.price.startsWith('8.75')).toBe(true);
  });
});

async function freshQuote(
  ids: { instrumentId: string; symbol: string },
  trading: TradingService,
  updateId: string,
  bid: string,
  ask: string,
): Promise<void> {
  const engine = new MarketDataEngine(
    {
      providerId: 'test-fixture',
      priceOrigin: 'TEST_FIXTURE',
      sink: new MarketDataStore(pool),
      clock: () => new Date('2026-11-21T16:05:00.000Z'),
    },
    [
      {
        id: ids.instrumentId,
        market: 'EQUITIES',
        venue: 'NASDAQ',
        symbol: ids.symbol,
        providerSymbol: ids.symbol.toLowerCase(),
        priceScale: 2,
        quantityScale: 8,
      },
    ],
  );
  const bridge = bindTradingQuotes(engine, new Phase2Orders(pool, trading, null, true));
  await engine.ingest(
    {
      kind: 'quote',
      providerEventId: `fresh-${updateId}`,
      providerSymbol: ids.symbol.toLowerCase(),
      bid,
      ask,
      bidSize: '8',
      askSize: '8',
      last: null,
      sourceTimestamp: '2026-11-21T16:05:00.000Z',
      sequence: Number(updateId),
      quoteUpdateId: updateId,
    },
    new Date('2026-11-21T16:05:00.000Z'),
  );
  await bridge.idle();
}

async function snapshot(instrumentId: string, feed: string): Promise<void> {
  await pool.query(
    `INSERT INTO quote_snapshots (
       instrument_id, bid, ask, bid_size, ask_size, source_timestamp, received_timestamp,
       processed_timestamp, sequence_no, provider_event_id, price_origin, feed_state
     ) VALUES ($1, 10, 10.2, 5, 5, now(), now(), now(), 1, '1', 'TEST_FIXTURE', $2)`,
    [instrumentId, feed],
  );
}

async function openPosition(
  ids: { accountId: string; instrumentId: string },
  quantity: string,
  entry: string,
): Promise<string> {
  const position = await pool.query<{ id: string }>(
    `INSERT INTO positions (account_id, instrument_id, status, quantity, average_entry, opened_at)
     VALUES ($1, $2, 'OPEN', $3, $4, now()) RETURNING id`,
    [ids.accountId, ids.instrumentId, quantity, entry],
  );
  return position.rows[0]?.id ?? '';
}

async function makeAccount(label: string): Promise<{
  userId: string;
  accountId: string;
  instrumentId: string;
  symbol: string;
  positionId: string;
}> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>(
      'INSERT INTO users (email) VALUES ($1) RETURNING id',
      [`risk-${label}-${suffix}@example.com`],
    );
    const userId = user.rows[0]?.id ?? '';
    const size = (46000 + (Number.parseInt(suffix.slice(0, 4), 16) % 400000)).toFixed(4);
    const product = await client.query<{ id: string }>(
      `INSERT INTO challenge_products (account_size, currency, active) VALUES ($1, 'USD', true) RETURNING id`,
      [size],
    );
    const price = await client.query<{ id: string }>(
      `INSERT INTO product_price_versions (product_id, price, currency, valid_from, decision_ref)
       VALUES ($1, 100, 'USD', now(), $2) RETURNING id`,
      [product.rows[0]?.id, `RQ-${suffix}`],
    );
    const rules = await client.query<{ id: string }>(
      `INSERT INTO rule_sets (code, account_type) VALUES ($1, 'CHALLENGE') RETURNING id`,
      [`RSK_${suffix}`.slice(0, 32).toUpperCase()],
    );
    const version = await client.query<{ id: string }>(
      `INSERT INTO rule_set_versions (rule_set_id, version_number, decision_ref, published_at)
       VALUES ($1, 1, $2, now()) RETURNING id`,
      [rules.rows[0]?.id, `RR-${suffix}`],
    );
    await client.query(
      `INSERT INTO commission_market_scopes (rule_set_version_id, market, decision_ref)
       VALUES ($1, 'EQUITIES', $2)`,
      [version.rows[0]?.id, `RC-${suffix}`],
    );
    const evidence = await client.query<{ id: string }>(
      `INSERT INTO purchase_evidence_references (
         source_system, idempotency_key, external_reference, user_id, price_version_id, amount, currency, verified_at
       ) VALUES ('M-08', $1, $2, $3, $4, 100, 'USD', now()) RETURNING id`,
      [`rq-${suffix}`, `rx-${suffix}`, userId, price.rows[0]?.id],
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
      [accountId, `rq-act-${suffix}`],
    );
    await client.query(`UPDATE trading_accounts SET state = 'ACTIVE' WHERE id = $1`, [accountId]);
    const symbol = `R${suffix}`.slice(0, 16).toUpperCase();
    const instrument = await client.query<{ id: string }>(
      `INSERT INTO instruments (
         market, venue, symbol, provider_symbol, price_scale, quantity_scale, trading_status, quote_asset
       ) VALUES ('EQUITIES', 'NASDAQ', $1, $2, 2, 8, 'TRADABLE', 'USD') RETURNING id`,
      [symbol, symbol.toLowerCase()],
    );
    await client.query('COMMIT');
    return {
      userId,
      accountId,
      instrumentId: instrument.rows[0]?.id ?? '',
      symbol,
      positionId: '',
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
