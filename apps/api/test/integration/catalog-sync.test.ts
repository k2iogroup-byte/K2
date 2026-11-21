import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiPackageRoot } from '../../src/config/paths.js';
import { migrateUp } from '../../src/infrastructure/db/migrator.js';
import { syncExchangeCatalog } from '../../src/modules/market-data/catalog-sync.js';
import { TradingService } from '../../src/modules/trading/trading-service.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a database whose name ends with _test');
if (!new URL(databaseUrl).pathname.replace(/^\//, '').endsWith('_test')) {
  throw new Error(
    'Refusing to run integration tests against a database whose name does not end with _test',
  );
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const fixture = JSON.parse(
  readFileSync(path.join(apiPackageRoot(), 'test/fixtures/binance-exchange-info.json'), 'utf8'),
) as { symbols: { symbol: string }[] };

describe('binance catalog sync', () => {
  beforeAll(async () => {
    await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('loads the recorded exchangeInfo without a network call and halts a break symbol', async () => {
    const precision = await pool.query<{ tiny: string; btc: string; qty: string }>(
      `SELECT '0.00000123'::numeric(24,8)::text AS tiny,
              '100000'::numeric(24,8)::text AS btc,
              '9000000000'::numeric(24,8)::text AS qty`,
    );
    expect(precision.rows[0]).toEqual({
      tiny: '0.00000123',
      btc: '100000.00000000',
      qty: '9000000000.00000000',
    });

    const equity = await pool.query<{ id: string }>(
      `INSERT INTO instruments (
         market, venue, symbol, provider_symbol, price_scale, quantity_scale, trading_status, quote_asset
       ) VALUES ('EQUITIES', 'NASDAQ', $1, $2, 2, 8, 'TRADABLE', 'USD')
       RETURNING id`,
      [`EQ${randomUUID().slice(0, 8)}`.toUpperCase(), `eq${randomUUID().slice(0, 8)}`],
    );
    const first = await syncExchangeCatalog(pool, fixture);
    expect(first.tradable).toBe(2);
    expect(first.halted).toBe(1);
    expect(first.ignored).toBe(1);
    const rows = await pool.query<{
      symbol: string;
      trading_status: string;
      price_scale: number;
      quantity_scale: number;
      tick_size: string;
      max_qty: string;
    }>(
      `SELECT instruments.symbol, instruments.trading_status, instruments.price_scale,
              instruments.quantity_scale, instrument_exchange_filters.tick_size,
              instrument_exchange_filters.max_qty
         FROM instruments
         JOIN instrument_exchange_filters ON instrument_exchange_filters.instrument_id = instruments.id
        WHERE instruments.symbol IN ('ZBTCUSDT', 'ZPEPEUSDT', 'ZOLDUSDT')
        ORDER BY instruments.symbol`,
    );
    expect(rows.rows).toEqual([
      {
        symbol: 'ZBTCUSDT',
        trading_status: 'TRADABLE',
        price_scale: 2,
        quantity_scale: 5,
        tick_size: '0.01000000',
        max_qty: '9000.00000000',
      },
      {
        symbol: 'ZOLDUSDT',
        trading_status: 'HALTED',
        price_scale: 2,
        quantity_scale: 3,
        tick_size: '0.01000000',
        max_qty: '1000.00000000',
      },
      {
        symbol: 'ZPEPEUSDT',
        trading_status: 'TRADABLE',
        price_scale: 8,
        quantity_scale: 0,
        tick_size: '0.00000123',
        max_qty: '9000000000',
      },
    ]);
    const equityStatus = await pool.query<{ trading_status: string }>(
      'SELECT trading_status FROM instruments WHERE id = $1',
      [equity.rows[0]?.id],
    );
    expect(equityStatus.rows[0]?.trading_status).toBe('TRADABLE');

    const withoutBtc = {
      symbols: fixture.symbols.filter((symbol) => symbol.symbol !== 'ZBTCUSDT'),
    };
    await syncExchangeCatalog(pool, withoutBtc);
    const halted = await pool.query<{ trading_status: string }>(
      `SELECT trading_status FROM instruments WHERE symbol = 'ZBTCUSDT'`,
    );
    expect(halted.rows[0]?.trading_status).toBe('HALTED');
  });

  it('rejects an off-tick crypto buy and still allows a halted close', async () => {
    await syncExchangeCatalog(pool, fixture);
    const pepe = await instrumentId('ZPEPEUSDT');
    const old = await instrumentId('ZOLDUSDT');
    const account = await openAccount();
    const stub = new TradingService(pool, { fillsEnabled: true });
    const offTick = await stub.submit(order(account, pepe, '0.00000124', '1000000000'));
    expect(offTick.rejectReason).toBe('TICK_SIZE');
    const aligned = await stub.submit(order(account, pepe, '0.00000123', '1000000000'));
    expect(aligned.rejectReason).toBe('TEMPORARILY_UNAVAILABLE');

    const haltedBuy = await stub.submit(order(account, old, '10.00', '1.000'));
    expect(haltedBuy.rejectReason).toBe('INSTRUMENT_NOT_TRADABLE');
    const holder = await openAccount();
    await pool.query(
      `INSERT INTO positions (account_id, instrument_id, status, quantity, average_entry, cost_basis)
       VALUES ($1, $2, 'OPEN', 1, 10, 10)`,
      [holder.accountId, old],
    );
    const approved = new TradingService(pool, {
      fillsEnabled: true,
      authorizer: {
        authorize: () =>
          Promise.resolve({
            decision: 'APPROVE' as const,
            decisionId: randomUUID(),
            reasonCode: 'TEST_APPROVED',
            mode: 'TEST_DOUBLE' as const,
          }),
      },
    });
    const closed = await approved.submit({
      ...order(holder, old, '10.00', '1.000'),
      side: 'SELL',
      quote: {
        quoteUpdateId: '9',
        bid: '10.00',
        ask: '10.02',
        bidSize: '5.000',
        askSize: '5.000',
        receivedAt: new Date(),
        feedState: 'LIVE',
        priceOrigin: 'TEST_FIXTURE',
      },
    });
    expect(closed.rejectReason).toBeNull();
    expect(closed.state).toBe('FILLED');
  });
});

async function instrumentId(symbol: string): Promise<string> {
  const row = await pool.query<{ id: string }>('SELECT id FROM instruments WHERE symbol = $1', [
    symbol,
  ]);
  const id = row.rows[0]?.id;
  if (!id) throw new Error(`missing ${symbol}`);
  return id;
}

function order(
  ids: { accountId: string; userId: string },
  instrumentId: string,
  ask: string,
  quantity: string,
) {
  return {
    accountId: ids.accountId,
    userId: ids.userId,
    instrumentId,
    clientOrderId: randomUUID(),
    idempotencyKey: randomUUID(),
    side: 'BUY' as const,
    orderType: 'MARKET' as const,
    quantity,
    limitPrice: null,
    quote: {
      quoteUpdateId: String(Date.now()),
      bid: ask,
      ask,
      bidSize: quantity,
      askSize: quantity,
      receivedAt: new Date(),
      feedState: 'LIVE' as const,
      priceOrigin: 'TEST_FIXTURE' as const,
    },
  };
}

async function openAccount(): Promise<{ userId: string; accountId: string }> {
  const client = await pool.connect();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>(
      'INSERT INTO users (email) VALUES ($1) RETURNING id',
      [`catalog-${suffix}@example.com`],
    );
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error('user');
    const picked = 21000 + (Number.parseInt(suffix.slice(0, 4), 16) % 500000);
    const product = await client.query<{ id: string }>(
      `INSERT INTO challenge_products (account_size, currency, active)
       VALUES ($1, 'USD', true) RETURNING id`,
      [(picked === 300000 ? 300001 : picked).toFixed(4)],
    );
    const productId = product.rows[0]?.id;
    const price = await client.query<{ id: string }>(
      `INSERT INTO product_price_versions (product_id, price, currency, valid_from, decision_ref)
       VALUES ($1, 100, 'USD', now(), $2) RETURNING id`,
      [productId, `P-${suffix}`.slice(0, 64)],
    );
    const rules = await client.query<{ id: string }>(
      `INSERT INTO rule_sets (code, account_type) VALUES ($1, 'CHALLENGE') RETURNING id`,
      [`RULE_${suffix}`.slice(0, 40).toUpperCase()],
    );
    const version = await client.query<{ id: string }>(
      `INSERT INTO rule_set_versions (rule_set_id, version_number, decision_ref, published_at)
       VALUES ($1, 1, $2, now()) RETURNING id`,
      [rules.rows[0]?.id, `R-${suffix}`.slice(0, 64)],
    );
    await client.query(
      `INSERT INTO commission_market_scopes (rule_set_version_id, market, decision_ref)
       VALUES ($1, 'CRYPTO', $2)`,
      [version.rows[0]?.id, `C-${suffix}`.slice(0, 64)],
    );
    const evidence = await client.query<{ id: string }>(
      `INSERT INTO purchase_evidence_references (
         source_system, idempotency_key, external_reference, user_id, price_version_id,
         amount, currency, verified_at
       ) VALUES ('M-08', $1, $2, $3, $4, 100, 'USD', now()) RETURNING id`,
      [`buy-${suffix}`, `ext-${suffix}`, userId, price.rows[0]?.id],
    );
    const account = await client.query<{ id: string }>(
      `INSERT INTO trading_accounts (
         user_id, account_type, stage, state, initial_capital, currency, product_id,
         price_version_id, rule_set_version_id, purchase_evidence_id, provisioned_at
       ) VALUES ($1, 'CHALLENGE', 'STAGE_1', 'PROVISIONED', 10000, 'USD', $2, $3, $4, $5, now())
       RETURNING id`,
      [userId, productId, price.rows[0]?.id, version.rows[0]?.id, evidence.rows[0]?.id],
    );
    const accountId = account.rows[0]?.id;
    if (!accountId) throw new Error('account');
    await client.query(
      `INSERT INTO account_state_transitions (
         account_id, from_state, to_state, reason_code, reason, actor_type, idempotency_key
       ) VALUES ($1, 'PROVISIONED', 'ACTIVE', 'SYSTEM_ACTIVATE', 'catalog test', 'SYSTEM', $2)`,
      [accountId, `activate-${suffix}`],
    );
    await client.query(`UPDATE trading_accounts SET state = 'ACTIVE' WHERE id = $1`, [accountId]);
    await client.query('COMMIT');
    return { userId, accountId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
