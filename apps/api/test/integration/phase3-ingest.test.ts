import { randomUUID } from 'node:crypto';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiPackageRoot } from '../../src/config/paths.js';
import { migrateUp } from '../../src/infrastructure/db/migrator.js';
import type { InstrumentDefinition } from '../../src/modules/market-data/engine.js';
import { MarketDataEngine } from '../../src/modules/market-data/engine.js';
import { MarketDataStore } from '../../src/modules/market-data/store.js';
import { Phase2Orders } from '../../src/modules/trading/phase2-orders.js';
import { bindTradingQuotes } from '../../src/modules/trading/quote-bridge.js';
import type {
  RiskAuthorizer,
  RiskDecision,
  SessionCalendar,
} from '../../src/modules/trading/risk-authorizer.js';
import { TradingLock } from '../../src/modules/trading/singleton.js';
import { TradingService } from '../../src/modules/trading/trading-service.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a database whose name ends with _test');

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const receivedAt = new Date('2026-11-21T16:00:00.000Z');
let heldLock: TradingLock;

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

describe('quotes from the market-data engine fire triggers', () => {
  beforeAll(async () => {
    await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
    heldLock = new TradingLock();
    expect(await heldLock.acquire(databaseUrl)).toBe('held');
  });

  afterAll(async () => {
    await heldLock.release();
    await pool.end();
  });

  it('fires a buy stop, a stop loss, and a take profit from fixture quotes', async () => {
    const stop = await seedEntry('stop', '10');
    await quote(stop, '12.00', '11.50', '11');
    const stopFill = await fills(stop.accountId);
    expect(stopFill).toHaveLength(1);
    expect(stopFill[0]?.quantity).toBe('1.00000000');
    expect(stopFill[0]?.price.startsWith('12')).toBe(true);

    const loss = await seedProtection('loss', 'STOP_LOSS', '9');
    await quote(loss, '9.20', '9.00', '12');
    const lossFill = await fills(loss.accountId);
    expect(lossFill).toHaveLength(1);
    expect(lossFill[0]?.quantity).toBe('1.00000000');
    expect(lossFill[0]?.price.startsWith('9')).toBe(true);

    const target = await seedProtection('target', 'TAKE_PROFIT', '11');
    await quote(target, '11.40', '11.00', '13');
    const targetFill = await fills(target.accountId);
    expect(targetFill).toHaveLength(1);
    expect(targetFill[0]?.price.startsWith('11')).toBe(true);
  });

  it('fills a repeated quote once and ignores an older update id', async () => {
    const ids = await seedEntry('dup', '10');
    const engine = book(ids);
    const bridge = bindTradingQuotes(engine, orders(heldLock));
    await engine.ingest(raw(ids.symbol, '20', '12.00', '11.50', 'a'), receivedAt);
    await engine.ingest(raw(ids.symbol, '20', '15.00', '14.00', 'b', 21), receivedAt);
    await bridge.idle();
    const once = await fills(ids.accountId);
    expect(once).toHaveLength(1);
    expect(once[0]?.price.startsWith('12')).toBe(true);

    const older = await seedEntry('old', '10');
    const olderEngine = book(older);
    const olderBridge = bindTradingQuotes(olderEngine, orders(heldLock));
    await olderEngine.ingest(raw(older.symbol, '30', '12.00', '11.50', 'c'), receivedAt);
    await olderEngine.ingest(raw(older.symbol, '4', '18.00', '17.00', 'd', 31), receivedAt);
    await olderBridge.idle();
    const kept = await fills(older.accountId);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.price.startsWith('12')).toBe(true);
  });

  it('does nothing without the lock, then fires the stored snapshot after the lock is acquired', async () => {
    const ids = await seedEntry('lock', '10');
    const engine = book(ids);
    const idle = bindTradingQuotes(engine, orders(new TradingLock()));
    await engine.ingest(raw(ids.symbol, '40', '12.00', '11.50', 'e'), receivedAt);
    await idle.idle();
    expect(await fills(ids.accountId)).toHaveLength(0);
    await orders(heldLock).evaluateSnapshots();
    const fired = await fills(ids.accountId);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.quantity).toBe('1.00000000');
    expect(fired[0]?.price.startsWith('12')).toBe(true);
  });
});

function orders(lock: TradingLock): Phase2Orders {
  return new Phase2Orders(
    pool,
    new TradingService(pool, {
      authorizer: new ApprovingRiskAuthorizer(),
      calendar: new OpenEquityCalendar(),
      fillsEnabled: true,
      lock,
    }),
    lock,
    true,
  );
}

function book(ids: { instrumentId: string; symbol: string }): MarketDataEngine {
  return new MarketDataEngine(
    {
      providerId: 'test-fixture',
      priceOrigin: 'TEST_FIXTURE',
      sink: new MarketDataStore(pool),
      clock: () => receivedAt,
    },
    [definition(ids)],
  );
}

function definition(ids: { instrumentId: string; symbol: string }): InstrumentDefinition {
  return {
    id: ids.instrumentId,
    market: 'EQUITIES',
    venue: 'NASDAQ',
    symbol: ids.symbol,
    providerSymbol: ids.symbol.toLowerCase(),
    priceScale: 2,
    quantityScale: 8,
  };
}

function raw(
  symbol: string,
  updateId: string,
  ask: string,
  bid: string,
  event: string,
  sequence = Number(updateId),
) {
  return {
    kind: 'quote' as const,
    providerEventId: `${event}-${updateId}`,
    providerSymbol: symbol.toLowerCase(),
    bid,
    ask,
    bidSize: '5',
    askSize: '5',
    last: null,
    sourceTimestamp: receivedAt.toISOString(),
    sequence,
    quoteUpdateId: updateId,
  };
}

async function quote(
  ids: { instrumentId: string; symbol: string },
  ask: string,
  bid: string,
  updateId: string,
): Promise<void> {
  const engine = book(ids);
  const bridge = bindTradingQuotes(engine, orders(heldLock));
  await engine.ingest(raw(ids.symbol, updateId, ask, bid, 'q'), receivedAt);
  await bridge.idle();
}

async function fills(accountId: string): Promise<{ price: string; quantity: string }[]> {
  const rows = await pool.query<{ price: string; quantity: string }>(
    `SELECT price::text, quantity::text FROM executions WHERE account_id = $1`,
    [accountId],
  );
  return rows.rows;
}

async function seedEntry(
  label: string,
  trigger: string,
): Promise<{ userId: string; accountId: string; instrumentId: string; symbol: string }> {
  const ids = await makeAccount(label);
  await pool.query(
    `INSERT INTO conditional_orders (
       account_id, user_id, instrument_id, kind, side, trigger_price, quantity, state
     ) VALUES ($1, $2, $3, 'ENTRY_STOP', 'BUY', $4, 1, 'PENDING')`,
    [ids.accountId, ids.userId, ids.instrumentId, trigger],
  );
  return ids;
}

async function seedProtection(
  label: string,
  kind: 'STOP_LOSS' | 'TAKE_PROFIT',
  trigger: string,
): Promise<{ userId: string; accountId: string; instrumentId: string; symbol: string }> {
  const ids = await makeAccount(label);
  const position = await pool.query<{ id: string }>(
    `INSERT INTO positions (account_id, instrument_id, status, quantity, average_entry, opened_at)
     VALUES ($1, $2, 'OPEN', 1, 10, now()) RETURNING id`,
    [ids.accountId, ids.instrumentId],
  );
  await pool.query(
    `INSERT INTO conditional_orders (
       account_id, user_id, instrument_id, position_id, kind, side, trigger_price, state
     ) VALUES ($1, $2, $3, $4, $5, 'SELL', $6, 'PENDING')`,
    [ids.accountId, ids.userId, ids.instrumentId, position.rows[0]?.id, kind, trigger],
  );
  return ids;
}

async function makeAccount(
  label: string,
): Promise<{ userId: string; accountId: string; instrumentId: string; symbol: string }> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>(
      'INSERT INTO users (email) VALUES ($1) RETURNING id',
      [`ingest-${label}-${suffix}@example.com`],
    );
    const userId = user.rows[0]?.id ?? '';
    const size = (45000 + (Number.parseInt(suffix.slice(0, 4), 16) % 400000)).toFixed(4);
    const product = await client.query<{ id: string }>(
      `INSERT INTO challenge_products (account_size, currency, active) VALUES ($1, 'USD', true) RETURNING id`,
      [size],
    );
    const price = await client.query<{ id: string }>(
      `INSERT INTO product_price_versions (product_id, price, currency, valid_from, decision_ref)
       VALUES ($1, 100, 'USD', now(), $2) RETURNING id`,
      [product.rows[0]?.id, `IQ-${suffix}`],
    );
    const rules = await client.query<{ id: string }>(
      `INSERT INTO rule_sets (code, account_type) VALUES ($1, 'CHALLENGE') RETURNING id`,
      [`ING_${suffix}`.slice(0, 32).toUpperCase()],
    );
    const version = await client.query<{ id: string }>(
      `INSERT INTO rule_set_versions (rule_set_id, version_number, decision_ref, published_at)
       VALUES ($1, 1, $2, now()) RETURNING id`,
      [rules.rows[0]?.id, `IR-${suffix}`],
    );
    await client.query(
      `INSERT INTO commission_market_scopes (rule_set_version_id, market, decision_ref)
       VALUES ($1, 'EQUITIES', $2)`,
      [version.rows[0]?.id, `IC-${suffix}`],
    );
    const evidence = await client.query<{ id: string }>(
      `INSERT INTO purchase_evidence_references (
         source_system, idempotency_key, external_reference, user_id, price_version_id, amount, currency, verified_at
       ) VALUES ('M-08', $1, $2, $3, $4, 100, 'USD', now()) RETURNING id`,
      [`iq-${suffix}`, `ix-${suffix}`, userId, price.rows[0]?.id],
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
      [accountId, `iq-act-${suffix}`],
    );
    await client.query(`UPDATE trading_accounts SET state = 'ACTIVE' WHERE id = $1`, [accountId]);
    const symbol = `Q${suffix}`.slice(0, 16).toUpperCase();
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
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
