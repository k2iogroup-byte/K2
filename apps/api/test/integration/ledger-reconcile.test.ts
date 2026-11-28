import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { PoolClient } from 'pg';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiPackageRoot } from '../../src/config/paths.js';
import { migrateUp } from '../../src/infrastructure/db/migrator.js';
import { liftLedgerFreeze, reconcileLedger } from '../../src/modules/ledger/reconcile.js';
import { RiskEngineAuthorizer } from '../../src/modules/risk/engine.js';
import type { SessionCalendar } from '../../src/modules/trading/risk-authorizer.js';
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

class OpenEquityCalendar implements SessionCalendar {
  equitySessionOpen(): boolean {
    return true;
  }
}

describe('ledger reconciliation on postgres', () => {
  beforeAll(async () => {
    await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('does not freeze an account that still has an unposted outbox row', async () => {
    const ids = await makeAccount();
    await pool.query(
      `INSERT INTO simulation_cash_projections (account_id, cash) VALUES ($1, 10000)`,
      [ids.accountId],
    );
    await pool.query(
      `INSERT INTO journal_entries (
         account_id, entry_type, amount, cash_effect, idempotency_key, actor_type
       ) VALUES ($1, 'FILL', -100, true, $2, 'SYSTEM')`,
      [ids.accountId, `gap:${ids.accountId}`],
    );
    await pool.query(
      `INSERT INTO ledger_outbox (event_type, idempotency_key, account_id, amount)
       VALUES ('fill', $1, $2, 10)`,
      [`fill:pending:${ids.accountId}`, ids.accountId],
    );
    await reconcileLedger(pool);
    const freezes = await pool.query(`SELECT id FROM ledger_freezes WHERE account_id = $1`, [
      ids.accountId,
    ]);
    expect(freezes.rowCount).toBe(0);
  });

  it('freezes new buys and still closes a position', async () => {
    const ids = await makeAccount();
    await pool.query(
      `INSERT INTO simulation_cash_projections (account_id, cash) VALUES ($1, 10000)`,
      [ids.accountId],
    );
    await pool.query(
      `INSERT INTO positions (account_id, instrument_id, status, quantity, average_entry, opened_at)
       VALUES ($1, $2, 'OPEN', 1, 10, now())`,
      [ids.accountId, ids.instrumentId],
    );
    await pool.query(
      `INSERT INTO journal_entries (
         account_id, entry_type, amount, cash_effect, idempotency_key, actor_type
       ) VALUES ($1, 'FILL', -100, true, $2, 'SYSTEM')`,
      [ids.accountId, `gap:${ids.accountId}`],
    );
    await reconcileLedger(pool);
    const anomaly = await pool.query<{
      severity: string;
      expected_amount: string;
      actual_amount: string;
      source_module: string;
      kind: string;
    }>(
      `SELECT severity, expected_amount::text, actual_amount::text, source_module, kind
       FROM ledger_anomalies WHERE account_id = $1`,
      [ids.accountId],
    );
    expect(anomaly.rows).toEqual([
      {
        severity: 'CRITICAL',
        expected_amount: '10000.0000',
        actual_amount: '9900.0000',
        source_module: 'M07',
        kind: 'CASH_MISMATCH',
      },
    ]);
    const frozen = await withClient((client) =>
      new RiskEngineAuthorizer().authorize(
        {
          accountId: ids.accountId,
          instrumentId: ids.instrumentId,
          side: 'BUY',
          quantity: '1.00000000',
          orderType: 'MARKET',
          bid: '10.00',
          ask: '10.00',
        },
        client,
      ),
    );
    expect(frozen.reasonCode).toBe('LEDGER_FROZEN');
    await pool.query(
      `INSERT INTO liquidity_levels (
         instrument_id, source, book_side, price, quote_update_id, displayed_qty, consumed_qty
       ) VALUES ($1, 'test-fixture', 'BID', 10, '80', 5, 0)`,
      [ids.instrumentId],
    );
    const trading = new TradingService(pool, {
      calendar: new OpenEquityCalendar(),
      fillsEnabled: true,
    });
    const closed = await trading.submit(sell(ids));
    expect(closed.rejectReason).toBeNull();
    expect(closed.state).toBe('FILLED');
    await withClient((client) => liftLedgerFreeze(client, ids.accountId, 'SYSTEM'));
    const lifted = await withClient((client) =>
      new RiskEngineAuthorizer().authorize(
        {
          accountId: ids.accountId,
          instrumentId: ids.instrumentId,
          side: 'BUY',
          quantity: '1.00000000',
          orderType: 'MARKET',
          bid: '10.00',
          ask: '10.00',
        },
        client,
      ),
    );
    expect(lifted.reasonCode).not.toBe('LEDGER_FROZEN');
  });

  it('warns on half a cent and freezes that gap on the next cycle', async () => {
    const ids = await makeAccount();
    await pool.query(
      `INSERT INTO simulation_cash_projections (account_id, cash) VALUES ($1, 10000)`,
      [ids.accountId],
    );
    await pool.query(
      `INSERT INTO journal_entries (
         account_id, entry_type, amount, cash_effect, idempotency_key, actor_type
       ) VALUES ($1, 'FILL', -0.0050, true, $2, 'SYSTEM')`,
      [ids.accountId, `cent:${ids.accountId}`],
    );
    await reconcileLedger(pool);
    const warned = await pool.query<{ event_type: string; severity: string }>(
      `SELECT event_type, severity FROM ledger_anomaly_current WHERE account_id = $1`,
      [ids.accountId],
    );
    expect(warned.rows).toEqual([{ event_type: 'OBSERVED', severity: 'WARNING' }]);
    expect(await freezeCount(ids.accountId)).toBe(0);
    await reconcileLedger(pool);
    const escalated = await pool.query<{ event_type: string; severity: string }>(
      `SELECT event_type, severity FROM ledger_anomaly_current WHERE account_id = $1`,
      [ids.accountId],
    );
    expect(escalated.rows).toEqual([{ event_type: 'ESCALATED', severity: 'CRITICAL' }]);
    expect(await freezeCount(ids.accountId)).toBe(1);
  });

  it('freezes a five dollar gap on the first cycle', async () => {
    const ids = await makeAccount();
    await pool.query(
      `INSERT INTO simulation_cash_projections (account_id, cash) VALUES ($1, 10000)`,
      [ids.accountId],
    );
    await pool.query(
      `INSERT INTO journal_entries (
         account_id, entry_type, amount, cash_effect, idempotency_key, actor_type
       ) VALUES ($1, 'FILL', -5, true, $2, 'SYSTEM')`,
      [ids.accountId, `five:${ids.accountId}`],
    );
    await reconcileLedger(pool);
    const row = await pool.query<{ event_type: string; severity: string }>(
      `SELECT event_type, severity FROM ledger_anomaly_current WHERE account_id = $1`,
      [ids.accountId],
    );
    expect(row.rows).toEqual([{ event_type: 'OBSERVED', severity: 'CRITICAL' }]);
    expect(await freezeCount(ids.accountId)).toBe(1);
  });

  it('warns once when an outbox row is older than the stale threshold', async () => {
    const ids = await makeAccount();
    const now = new Date('2026-11-28T12:00:00.000Z');
    const old = new Date(now.getTime() - 301_000);
    const young = new Date(now.getTime() - 10_000);
    await pool.query(
      `INSERT INTO ledger_outbox (event_type, idempotency_key, account_id, amount, created_at)
       VALUES ('fill', $1, $2, 10, $3)`,
      [`stale:${ids.accountId}`, ids.accountId, old],
    );
    await reconcileLedger(pool, { now, staleAfterSeconds: 300 });
    await reconcileLedger(pool, { now, staleAfterSeconds: 300 });
    const warnings = await pool.query(
      `SELECT id FROM mismatch_events
       WHERE account_id = $1 AND event_type = 'STALE_OUTBOX'`,
      [ids.accountId],
    );
    expect(warnings.rowCount).toBe(1);
    expect(await freezeCount(ids.accountId)).toBe(0);
    const fresh = await makeAccount();
    await pool.query(
      `INSERT INTO ledger_outbox (event_type, idempotency_key, account_id, amount, created_at)
       VALUES ('fill', $1, $2, 10, $3)`,
      [`fresh:${fresh.accountId}`, fresh.accountId, young],
    );
    await reconcileLedger(pool, { now, staleAfterSeconds: 300 });
    const none = await pool.query(
      `SELECT id FROM mismatch_events WHERE account_id = $1 AND event_type = 'STALE_OUTBOX'`,
      [fresh.accountId],
    );
    expect(none.rowCount).toBe(0);
  });
});

async function freezeCount(accountId: string): Promise<number> {
  const freezes = await pool.query(`SELECT id FROM ledger_freezes WHERE account_id = $1`, [
    accountId,
  ]);
  return freezes.rowCount ?? 0;
}

function sell(ids: { accountId: string; userId: string; instrumentId: string }): OrderInput {
  const quote: ExecutableQuote = {
    quoteUpdateId: '80',
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
    side: 'SELL',
    orderType: 'MARKET',
    quantity: '1.00000000',
    limitPrice: null,
    quote,
  };
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
      [`recon-${suffix}@example.com`],
    );
    const userId = required(user.rows[0]?.id);
    const picked = 24000 + (Number.parseInt(suffix.slice(0, 4), 16) % 700000);
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
    const symbol = `RC${suffix}`.slice(0, 20).toUpperCase();
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
