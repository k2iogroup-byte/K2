import { randomUUID } from 'node:crypto';
import path from 'node:path';

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
import type { ExecutableQuote } from '../../src/modules/trading/trading-service.js';
import { TradingService } from '../../src/modules/trading/trading-service.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a database whose name ends with _test');

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

function quote(ask: string, updateId: string): ExecutableQuote {
  return {
    quoteUpdateId: updateId,
    bid: '9.00',
    ask,
    bidSize: '5.00000000',
    askSize: '5.00000000',
    receivedAt: new Date('2026-11-21T16:00:00.000Z'),
    feedState: 'LIVE',
    priceOrigin: 'TEST_FIXTURE',
  };
}

describe('buy stop orders', () => {
  beforeAll(async () => {
    await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('rests a stop, then fills the gapped ask and blocks a second entry', async () => {
    const ids = await makeAccount();
    const trading = new TradingService(pool, {
      authorizer: new ApprovingRiskAuthorizer(),
      calendar: new OpenEquityCalendar(),
      fillsEnabled: true,
    });
    const phase2 = new Phase2Orders(pool, trading, null, true);
    const placed = await phase2.placeStop({
      accountId: ids.accountId,
      userId: ids.userId,
      instrumentId: ids.instrumentId,
      clientOrderId: 'stop-1',
      idempotencyKey: `stop-${ids.accountId}`,
      quantity: '1',
      triggerPrice: '10.00',
      quote: quote('9.50', '1'),
    });
    expect(placed).toMatchObject({ state: 'PENDING', rejectReason: null });
    const replay = await phase2.placeStop({
      accountId: ids.accountId,
      userId: ids.userId,
      instrumentId: ids.instrumentId,
      clientOrderId: 'stop-1',
      idempotencyKey: `stop-${ids.accountId}`,
      quantity: '1',
      triggerPrice: '10.00',
      quote: quote('9.50', '1'),
    });
    expect(replay).toEqual(placed);
    await expect(
      phase2.placeStop({
        accountId: ids.accountId,
        userId: ids.userId,
        instrumentId: ids.instrumentId,
        clientOrderId: 'stop-2',
        idempotencyKey: `stop-other-${ids.accountId}`,
        quantity: '2',
        triggerPrice: '10.00',
        quote: null,
      }),
    ).resolves.toMatchObject({ rejectReason: 'POSITION_ALREADY_OPEN' });
    const blocked = await phase2.nativeBuyBlocked(ids.accountId, ids.userId, ids.instrumentId);
    expect(blocked).toBe(true);

    await phase2.onQuote(ids.instrumentId, quote('12.00', '2'));
    const execution = await pool.query<{ price: string; quantity: string }>(
      `SELECT price::text, quantity::text FROM executions WHERE account_id = $1`,
      [ids.accountId],
    );
    expect(execution.rows[0]?.quantity).toBe('1.00000000');
    expect(execution.rows[0]?.price.startsWith('12')).toBe(true);
    const view = await phase2.readOrder(ids.userId, placed.orderId ?? '');
    expect(view?.state).toBe('FILLED');
    expect(await phase2.readOrder(randomUUID(), placed.orderId ?? '')).toBeNull();
  });
});

async function makeAccount(): Promise<{ userId: string; accountId: string; instrumentId: string }> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>(
      'INSERT INTO users (email) VALUES ($1) RETURNING id',
      [`stop-${suffix}@example.com`],
    );
    const userId = user.rows[0]?.id ?? '';
    const size = (40000 + (Number.parseInt(suffix.slice(0, 4), 16) % 400000)).toFixed(4);
    const product = await client.query<{ id: string }>(
      `INSERT INTO challenge_products (account_size, currency, active) VALUES ($1, 'USD', true) RETURNING id`,
      [size],
    );
    const price = await client.query<{ id: string }>(
      `INSERT INTO product_price_versions (product_id, price, currency, valid_from, decision_ref)
       VALUES ($1, 100, 'USD', now(), $2) RETURNING id`,
      [product.rows[0]?.id, `SP-${suffix}`],
    );
    const rules = await client.query<{ id: string }>(
      `INSERT INTO rule_sets (code, account_type) VALUES ($1, 'CHALLENGE') RETURNING id`,
      [`STOP_${suffix}`.slice(0, 32).toUpperCase()],
    );
    const version = await client.query<{ id: string }>(
      `INSERT INTO rule_set_versions (rule_set_id, version_number, decision_ref, published_at)
       VALUES ($1, 1, $2, now()) RETURNING id`,
      [rules.rows[0]?.id, `SR-${suffix}`],
    );
    await client.query(
      `INSERT INTO commission_market_scopes (rule_set_version_id, market, decision_ref)
       VALUES ($1, 'EQUITIES', $2)`,
      [version.rows[0]?.id, `SC-${suffix}`],
    );
    const evidence = await client.query<{ id: string }>(
      `INSERT INTO purchase_evidence_references (
         source_system, idempotency_key, external_reference, user_id, price_version_id, amount, currency, verified_at
       ) VALUES ('M-08', $1, $2, $3, $4, 100, 'USD', now()) RETURNING id`,
      [`sp-${suffix}`, `sx-${suffix}`, userId, price.rows[0]?.id],
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
      [accountId, `sp-act-${suffix}`],
    );
    await client.query(`UPDATE trading_accounts SET state = 'ACTIVE' WHERE id = $1`, [accountId]);
    const symbol = `ST${suffix}`.slice(0, 16).toUpperCase();
    const instrument = await client.query<{ id: string }>(
      `INSERT INTO instruments (
         market, venue, symbol, provider_symbol, price_scale, quantity_scale, trading_status, quote_asset
       ) VALUES ('EQUITIES', 'NASDAQ', $1, $2, 2, 8, 'TRADABLE', 'USD') RETURNING id`,
      [symbol, symbol.toLowerCase()],
    );
    await client.query('COMMIT');
    return { userId, accountId, instrumentId: instrument.rows[0]?.id ?? '' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
