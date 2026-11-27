import { randomUUID } from 'node:crypto';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiPackageRoot } from '../../src/config/paths.js';
import { migrateUp } from '../../src/infrastructure/db/migrator.js';
import { drainLedger, postedCash } from '../../src/modules/ledger/drain.js';
import type {
  RiskAuthorizer,
  RiskDecision,
  SessionCalendar,
} from '../../src/modules/trading/risk-authorizer.js';
import type { ExecutableQuote, OrderInput } from '../../src/modules/trading/trading-service.js';
import { TradingService } from '../../src/modules/trading/trading-service.js';

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

describe('ledger drain on postgres', () => {
  beforeAll(async () => {
    await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('posts one journal row when the same fill is drained twice', async () => {
    const ids = await makeAccount();
    const service = trading();
    const bought = await service.submit(order(ids));
    expect(bought.rejectReason).toBeNull();
    expect(await drainLedger(pool)).toBeGreaterThan(0);
    expect(await drainLedger(pool)).toBe(0);
    const journal = await pool.query<{ entry_type: string; amount: string; actor_type: string }>(
      `SELECT entry_type, amount::text, actor_type
       FROM journal_entries WHERE account_id = $1 ORDER BY entry_type`,
      [ids.accountId],
    );
    expect(journal.rows).toEqual([
      { entry_type: 'COMMISSION', amount: '-0.0500', actor_type: 'SYSTEM' },
      { entry_type: 'FILL', amount: '-10.0000', actor_type: 'SYSTEM' },
      { entry_type: 'OPENING', amount: '10000.0000', actor_type: 'SYSTEM' },
    ]);
    const cash = await pool.query<{ cash: string }>(
      `SELECT cash::text FROM simulation_cash_projections WHERE account_id = $1`,
      [ids.accountId],
    );
    const client = await pool.connect();
    try {
      expect(await postedCash(client, ids.accountId)).toBe(cash.rows[0]?.cash);
    } finally {
      client.release();
    }
  });

  it('does not journal a zero commission and adds a sell back to cash', async () => {
    const ids = await makeAccount();
    const service = trading();
    const bought = await service.submit(order(ids, '1'));
    expect(bought.rejectReason).toBeNull();
    const execution = await pool.query<{ id: string }>(
      `SELECT id FROM executions WHERE account_id = $1`,
      [ids.accountId],
    );
    await pool.query(
      `INSERT INTO ledger_outbox (event_type, idempotency_key, account_id, execution_id, amount)
       VALUES ('commission', $1, $2, $3, 0)`,
      [`commission:zero:${ids.accountId}`, ids.accountId, execution.rows[0]?.id],
    );
    const sold = await service.submit(order(ids, '2', { side: 'SELL', quantity: '1.00000000' }));
    expect(sold.rejectReason).toBeNull();
    await drainLedger(pool);
    const types = await pool.query<{ entry_type: string; amount: string }>(
      `SELECT entry_type, amount::text FROM journal_entries
       WHERE account_id = $1 ORDER BY entry_type, amount`,
      [ids.accountId],
    );
    expect(types.rows).toEqual([
      { entry_type: 'COMMISSION', amount: '-0.0500' },
      { entry_type: 'FILL', amount: '-10.0000' },
      { entry_type: 'FILL', amount: '10.0000' },
      { entry_type: 'OPENING', amount: '10000.0000' },
    ]);
  });

  it('lets two drainers post one fill', async () => {
    const ids = await makeAccount();
    const bought = await trading().submit(order(ids, '3'));
    expect(bought.rejectReason).toBeNull();
    await Promise.all([drainLedger(pool), drainLedger(pool)]);
    const fills = await pool.query(
      `SELECT id FROM journal_entries WHERE account_id = $1 AND entry_type = 'FILL'`,
      [ids.accountId],
    );
    expect(fills.rowCount).toBe(1);
  });
});

function trading(): TradingService {
  return new TradingService(pool, {
    authorizer: new ApprovingRiskAuthorizer(),
    calendar: new OpenEquityCalendar(),
    fillsEnabled: true,
  });
}

function order(
  ids: { accountId: string; userId: string; instrumentId: string },
  updateId = '1',
  overrides: Partial<OrderInput> = {},
): OrderInput {
  const quote: ExecutableQuote = {
    quoteUpdateId: updateId,
    bid: '10.00',
    ask: '10.00',
    bidSize: '5.00000000',
    askSize: '5.00000000',
    receivedAt: new Date(),
    feedState: 'LIVE',
    priceOrigin: 'TEST_FIXTURE',
  };
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
    quote,
    ...overrides,
  };
}

async function makeAccount(): Promise<{
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
      [`ledger-${suffix}@example.com`],
    );
    const userId = required(user.rows[0]?.id);
    const picked = 23000 + (Number.parseInt(suffix.slice(0, 4), 16) % 700000);
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
    const symbol = `LD${suffix}`.slice(0, 20).toUpperCase();
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
