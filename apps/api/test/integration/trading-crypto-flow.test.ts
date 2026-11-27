import { randomUUID } from 'node:crypto';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiPackageRoot } from '../../src/config/paths.js';
import { migrateUp } from '../../src/infrastructure/db/migrator.js';
import {
  openLiveBookTickerFeed,
  type SocketLike,
} from '../../src/modules/market-data/binance-spot-ws.js';
import { syncExchangeCatalog } from '../../src/modules/market-data/catalog-sync.js';
import { MarketDataEngine } from '../../src/modules/market-data/engine.js';
import { closeByPercent } from '../../src/modules/trading/close-position.js';
import { Phase2Orders } from '../../src/modules/trading/phase2-orders.js';
import {
  attachFilledProtection,
  protectionHash,
  saveEntryProtection,
} from '../../src/modules/trading/protection.js';
import { bindTradingQuotes } from '../../src/modules/trading/quote-bridge.js';
import type { RiskAuthorizer, RiskDecision } from '../../src/modules/trading/risk-authorizer.js';
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

class MockSocket implements SocketLike {
  private message: ((data: string) => void) | null = null;

  send(): void {
    return undefined;
  }

  close(): void {
    return undefined;
  }

  onMessage(handler: (data: string) => void): void {
    this.message = handler;
  }

  onClose(): void {
    return undefined;
  }

  receive(data: string): void {
    this.message?.(data);
  }
}

let nextUpdate = Date.now();

function nextId(): string {
  nextUpdate += 1;
  return String(nextUpdate);
}

function symbolPair(prefix: string): { symbol: string; base: string } {
  const base = `${prefix}${randomUUID().replaceAll('-', '').slice(0, 6)}`.toUpperCase();
  return { symbol: `${base}USDT`, base };
}

function filters(symbol: string, base: string, volume?: string) {
  return {
    symbol,
    status: 'TRADING',
    baseAsset: base,
    quoteAsset: 'USDT',
    ...(volume === undefined ? {} : { quoteVolume: volume }),
    filters: [
      { filterType: 'PRICE_FILTER', tickSize: '0.01000000' },
      {
        filterType: 'LOT_SIZE',
        minQty: '0.00001000',
        maxQty: '9000.00000000',
        stepSize: '0.00001000',
      },
      { filterType: 'MIN_NOTIONAL', minNotional: '5.00000000' },
    ],
  };
}

function quote(
  updateId: string,
  bid: string,
  ask: string,
  feedState: ExecutableQuote['feedState'] = 'LIVE',
): ExecutableQuote {
  return {
    quoteUpdateId: updateId,
    bid,
    ask,
    bidSize: '10.00000',
    askSize: '10.00000',
    receivedAt: new Date(),
    feedState,
    priceOrigin: 'TEST_FIXTURE',
  };
}

describe('crypto trading flow', () => {
  beforeAll(async () => {
    await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('runs catalog, quote, buy, protection, and risk-reducing closes from fixtures', async () => {
    const flowSymbol = symbolPair('F');
    const quietSymbol = symbolPair('Q');
    const synced = await syncExchangeCatalog(pool, {
      symbols: [
        filters(flowSymbol.symbol, flowSymbol.base, '0'),
        filters(quietSymbol.symbol, quietSymbol.base),
      ],
    });
    expect(synced.tradable).toBe(2);
    const flow = await instrumentId(flowSymbol.symbol);
    const quiet = await instrumentId(quietSymbol.symbol);
    const engine = new MarketDataEngine({ providerId: 'binance-public', priceOrigin: 'VENDOR' }, [
      {
        id: flow,
        market: 'CRYPTO',
        venue: 'BINANCE_SPOT',
        symbol: flowSymbol.symbol,
        providerSymbol: flowSymbol.symbol.toLowerCase(),
        priceScale: 2,
        quantityScale: 5,
      },
    ]);
    const approved = new TradingService(pool, {
      authorizer: new ApprovingRiskAuthorizer(),
      fillsEnabled: true,
    });
    const phase2 = new Phase2Orders(pool, approved, null, true);
    const bridge = bindTradingQuotes(engine, phase2);
    const socket = new MockSocket();
    let ingested: Promise<unknown> = Promise.resolve();
    const feed = openLiveBookTickerFeed({
      mode: 'binance-public',
      connect: () => socket,
      clock: { now: () => Date.now(), delay: () => () => undefined },
      onEvent: (event) => {
        ingested = ingested.then(() => engine.ingest(event));
      },
    });
    feed?.subscribe([flowSymbol.symbol, 'ETHUSDC']);
    socket.receive(
      `{"u":${nextId()},"s":"${flowSymbol.symbol}","b":"9.90","B":"10.00000","a":"10.00","A":"10.00000"}`,
    );
    await ingested;
    await bridge.idle();
    expect(engine.quote(flowSymbol.symbol)?.ask).toBe('10.00');

    const buyer = await openAccount();
    const stub = new TradingService(pool, { fillsEnabled: true });
    const denied = await stub.submit(buy(buyer, flow, '4', quote(nextId(), '9.90', '10.00')));
    expect(denied.rejectReason).toBe('TEMPORARILY_UNAVAILABLE');
    const deniedFills = await pool.query('SELECT id FROM executions WHERE account_id = $1', [
      buyer.accountId,
    ]);
    expect(deniedFills.rowCount).toBe(0);

    const filled = await approved.submit(buy(buyer, flow, '4', quote(nextId(), '9.90', '10.00')));
    expect(filled).toMatchObject({
      state: 'FILLED',
      rejectReason: null,
      filledQuantity: '4.00000',
      cash: '9959.8000',
    });
    const execution = await pool.query<{
      price: string;
      notional: string;
      commission: string;
      live_market_data: boolean;
      execution_venue: string;
    }>(
      `SELECT price::text, notional::text, commission::text, live_market_data, execution_venue
         FROM executions WHERE account_id = $1`,
      [buyer.accountId],
    );
    expect(execution.rows[0]).toEqual({
      price: '10.00000000',
      notional: '40.0000',
      commission: '0.2000',
      live_market_data: false,
      execution_venue: 'K2_SIMULATION',
    });
    const scaled = await approved.submit(buy(buyer, flow, '1', quote(nextId(), '9.90', '10.00')));
    expect(scaled.rejectReason).toBe('POSITION_ALREADY_OPEN');
    const openPositions = await pool.query<{ id: string }>(
      `SELECT id FROM positions WHERE account_id = $1 AND status = 'OPEN'`,
      [buyer.accountId],
    );
    expect(openPositions.rowCount).toBe(1);

    const positionId = openPositions.rows[0]?.id;
    if (!positionId) throw new Error('missing position');
    for (const percentage of [25, 50, 75, 100] as const) {
      const closed = await closeByPercent(pool, approved, {
        positionId,
        userId: buyer.userId,
        percentage,
        idempotencyKey: `flow-${percentage}-${buyer.accountId}`,
        requestHash: protectionHash({ positionId, percentage }),
        quote: quote(nextId(), '10.00', '10.10'),
      });
      expect(closed.rejectReason).toBeNull();
      expect(closed.state).toBe('FILLED');
    }
    const flat = await pool.query<{ quantity: string }>(
      'SELECT quantity::text FROM positions WHERE id = $1',
      [positionId],
    );
    expect(flat.rows[0]?.quantity).toBe('0.00000000');
    const freshAudit = await pool.query<{ price_basis: string }>(
      `SELECT price_basis FROM risk_reducing_audits WHERE account_id = $1 ORDER BY created_at`,
      [buyer.accountId],
    );
    expect(freshAudit.rows.map((row) => row.price_basis)).toEqual([
      'FRESH',
      'FRESH',
      'FRESH',
      'FRESH',
    ]);

    const protectedAccount = await openAccount();
    await saveEntryProtection(pool, {
      accountId: protectedAccount.accountId,
      userId: protectedAccount.userId,
      instrumentId: flow,
      clientOrderId: 'protected-entry',
      stopLoss: '9.00',
      takeProfit: '12.00',
    });
    const protectedBuy = await approved.submit(
      buy(protectedAccount, flow, '1', quote(nextId(), '9.90', '10.00'), 'protected-entry'),
    );
    expect(protectedBuy.state).toBe('FILLED');
    await attachFilledProtection(pool, protectedAccount.accountId, flow);
    socket.receive(
      `{"u":${nextId()},"s":"${flowSymbol.symbol}","b":"9.00","B":"10","a":"9.10","A":"10"}`,
    );
    await ingested;
    await bridge.idle();
    const stopped = await pool.query<{ quantity: string; status: string }>(
      `SELECT quantity::text, status FROM positions WHERE account_id = $1`,
      [protectedAccount.accountId],
    );
    expect(stopped.rows[0]).toMatchObject({ quantity: '0.00000000', status: 'CLOSED' });

    const targetAccount = await openAccount();
    await saveEntryProtection(pool, {
      accountId: targetAccount.accountId,
      userId: targetAccount.userId,
      instrumentId: flow,
      clientOrderId: 'target-entry',
      stopLoss: '9.00',
      takeProfit: '12.00',
    });
    expect(
      (
        await approved.submit(
          buy(targetAccount, flow, '1', quote(nextId(), '9.90', '10.00'), 'target-entry'),
        )
      ).state,
    ).toBe('FILLED');
    await attachFilledProtection(pool, targetAccount.accountId, flow);
    await phase2.onQuote(flow, quote(nextId(), '12.00', '12.10'));
    const targeted = await pool.query<{ status: string }>(
      'SELECT status FROM positions WHERE account_id = $1',
      [targetAccount.accountId],
    );
    expect(targeted.rows[0]?.status).toBe('CLOSED');

    const staleAccount = await openAccount();
    expect(
      (await approved.submit(buy(staleAccount, flow, '1', quote(nextId(), '9.90', '10.00')))).state,
    ).toBe('FILLED');
    const stalePosition = await positionOf(staleAccount.accountId);
    const deferred = await closeByPercent(pool, approved, {
      positionId: stalePosition,
      userId: staleAccount.userId,
      percentage: 100,
      idempotencyKey: `stale-${staleAccount.accountId}`,
      requestHash: protectionHash({ positionId: stalePosition, percentage: 100 }),
      quote: quote(nextId(), '9.80', '9.90', 'STALE'),
    });
    expect(deferred.state).toBe('OPEN');
    await phase2.onQuote(flow, quote(nextId(), '9.70', '9.80'));
    const deferredAudit = await pool.query<{ price_basis: string }>(
      `SELECT price_basis FROM risk_reducing_audits WHERE account_id = $1 ORDER BY created_at`,
      [staleAccount.accountId],
    );
    expect(deferredAudit.rows.map((row) => row.price_basis)).toContain('DEFERRED_FRESH');
    const staleFlat = await pool.query<{ quantity: string }>(
      'SELECT quantity::text FROM positions WHERE id = $1',
      [stalePosition],
    );
    expect(staleFlat.rows[0]?.quantity).toBe('0.00000000');

    const fallbackAccount = await openAccount();
    await pool.query(
      `INSERT INTO positions (account_id, instrument_id, status, quantity, average_entry, cost_basis)
       VALUES ($1, $2, 'OPEN', 1, 10, 10)`,
      [fallbackAccount.accountId, quiet],
    );
    const fallbackPosition = await positionOf(fallbackAccount.accountId);
    const fallback = await closeByPercent(pool, approved, {
      positionId: fallbackPosition,
      userId: fallbackAccount.userId,
      percentage: 100,
      idempotencyKey: `fallback-${fallbackAccount.accountId}`,
      requestHash: protectionHash({ positionId: fallbackPosition, percentage: 100 }),
      quote: null,
    });
    expect(fallback.state).toBe('FILLED');
    const fallbackAudit = await pool.query<{ price_basis: string }>(
      'SELECT price_basis FROM risk_reducing_audits WHERE account_id = $1',
      [fallbackAccount.accountId],
    );
    expect(fallbackAudit.rows[0]?.price_basis).toBe('ENTRY_FALLBACK');
    const fallbackFill = await pool.query<{ price: string }>(
      'SELECT price::text FROM executions WHERE account_id = $1',
      [fallbackAccount.accountId],
    );
    expect(fallbackFill.rows[0]?.price.startsWith('10')).toBe(true);

    const equity = await pool.query<{ id: string }>(
      `INSERT INTO instruments (
         market, venue, symbol, provider_symbol, price_scale, quantity_scale, trading_status, quote_asset
       ) VALUES ('EQUITIES', 'NASDAQ', $1, $2, 2, 8, 'TRADABLE', 'USD') RETURNING id`,
      [`EQ${randomUUID().slice(0, 8)}`.toUpperCase(), `eq${randomUUID().slice(0, 8)}`],
    );
    const equityId = equity.rows[0]?.id ?? '';
    const equityBuy = await approved.submit(
      buy(buyer, equityId, '1', quote(nextId(), '10.00', '10.00')),
    );
    expect(equityBuy.rejectReason).toBe('CALENDAR_UNCOVERED');

    const outbox = await pool.query<{ posted_at: Date | null }>(
      'SELECT posted_at FROM ledger_outbox WHERE account_id = $1',
      [buyer.accountId],
    );
    expect(outbox.rowCount).toBeGreaterThan(0);
    expect(outbox.rows.every((row) => row.posted_at === null)).toBe(true);
    feed?.stop();
  });
});

function buy(
  account: { accountId: string; userId: string },
  instrumentId: string,
  quantity: string,
  quote: ExecutableQuote,
  clientOrderId: string = randomUUID(),
) {
  return {
    accountId: account.accountId,
    userId: account.userId,
    instrumentId,
    clientOrderId,
    idempotencyKey: randomUUID(),
    side: 'BUY' as const,
    orderType: 'MARKET' as const,
    quantity,
    limitPrice: null,
    quote,
  };
}

async function instrumentId(symbol: string): Promise<string> {
  const row = await pool.query<{ id: string }>('SELECT id FROM instruments WHERE symbol = $1', [
    symbol,
  ]);
  const id = row.rows[0]?.id;
  if (!id) throw new Error(`missing ${symbol}`);
  return id;
}

async function positionOf(accountId: string): Promise<string> {
  const row = await pool.query<{ id: string }>('SELECT id FROM positions WHERE account_id = $1', [
    accountId,
  ]);
  const id = row.rows[0]?.id;
  if (!id) throw new Error('missing position');
  return id;
}

async function openAccount(): Promise<{ userId: string; accountId: string }> {
  const client = await pool.connect();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>(
      'INSERT INTO users (email) VALUES ($1) RETURNING id',
      [`flow-${suffix}@example.com`],
    );
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error('user');
    const picked = 22000 + (Number.parseInt(suffix.slice(0, 4), 16) % 400000);
    const product = await client.query<{ id: string }>(
      `INSERT INTO challenge_products (account_size, currency, active)
       VALUES ($1, 'USD', true) RETURNING id`,
      [(picked === 300000 ? 300001 : picked).toFixed(4)],
    );
    const price = await client.query<{ id: string }>(
      `INSERT INTO product_price_versions (product_id, price, currency, valid_from, decision_ref)
       VALUES ($1, 100, 'USD', now(), $2) RETURNING id`,
      [product.rows[0]?.id, `P-${suffix}`.slice(0, 64)],
    );
    const rules = await client.query<{ id: string }>(
      `INSERT INTO rule_sets (code, account_type) VALUES ($1, 'CHALLENGE') RETURNING id`,
      [`FLOW_${suffix}`.slice(0, 40).toUpperCase()],
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
      [userId, product.rows[0]?.id, price.rows[0]?.id, version.rows[0]?.id, evidence.rows[0]?.id],
    );
    const accountId = account.rows[0]?.id;
    if (!accountId) throw new Error('account');
    await client.query(
      `INSERT INTO account_state_transitions (
         account_id, from_state, to_state, reason_code, reason, actor_type, idempotency_key
       ) VALUES ($1, 'PROVISIONED', 'ACTIVE', 'SYSTEM_ACTIVATE', 'crypto flow', 'SYSTEM', $2)`,
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
