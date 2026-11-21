import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for the trading fixture');

test('login, rejected buy, fixture position, and a filled 50 percent close', async ({
  request,
}) => {
  const email = `phase2-${randomUUID()}@example.com`;
  const registered = await request.post('/k2-api/auth/register', {
    headers: { 'x-k2-request': '1' },
    data: {
      firstName: 'Ada',
      lastName: 'Trader',
      username: `p2${randomUUID().replace(/-/g, '')}`.slice(0, 32),
      email,
      password: 'correct-horse-battery',
      country: 'United States',
      city: 'Chicago',
      streetAddress: '1 Market Street',
      postalCode: '60601',
      phone: '+1 (415) 555-2671',
    },
  });
  expect(registered.status()).toBe(202);
  const outbox = await readFile(path.resolve(process.cwd(), 'apps/api/.email-outbox'), 'utf8');
  const token = outbox
    .split('\n')
    .filter((line) => line.includes(email))
    .map((line) => /#([A-Za-z0-9_-]{43})/.exec(line)?.[1])
    .find((value) => value !== undefined);
  if (!token) throw new Error('verification token was not captured');
  expect(
    (
      await request.post('/k2-api/auth/email/verify', {
        headers: { 'x-k2-request': '1' },
        data: { token },
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await request.post('/k2-api/auth/login', {
        headers: { 'x-k2-request': '1' },
        data: { email, password: 'correct-horse-battery' },
      })
    ).status(),
  ).toBe(200);
  const me = await request.get('/k2-api/auth/me');
  expect(me.status()).toBe(200);
  const profile = (await me.json()) as { profile: { id: string } };
  const ids = await fixtureAccount(profile.profile.id);
  const csrf = (await request.storageState()).cookies.find((cookie) => cookie.name === 'k2_csrf');
  if (!csrf) throw new Error('csrf cookie missing');
  const order = await request.post('/k2-api/trading/orders', {
    headers: {
      'x-k2-request': '1',
      'x-csrf-token': csrf.value,
      'idempotency-key': `e2e-order-${ids.accountId}`,
    },
    data: {
      accountId: ids.accountId,
      instrumentId: ids.instrumentId,
      clientOrderId: 'e2e-buy',
      side: 'BUY',
      orderType: 'MARKET',
      quantity: '1',
      limitPrice: null,
    },
  });
  expect(order.status()).toBe(200);
  expect(await order.json()).toMatchObject({
    state: 'REJECTED',
    rejectReason: 'CALENDAR_UNCOVERED',
    liveMarketData: false,
    executionVenue: 'K2_SIMULATION',
  });
  const positionId = await insertOpenPosition(ids.accountId, ids.instrumentId);
  const listed = await request.get(`/k2-api/trading/positions?accountId=${ids.accountId}`);
  expect(listed.status()).toBe(200);
  const positions = (await listed.json()) as {
    positions: { positionId: string; quantity: string }[];
  };
  expect(positions.positions).toEqual([
    expect.objectContaining({ positionId, quantity: '2.00000000' }),
  ]);
  const closed = await request.post(`/k2-api/trading/positions/${positionId}/close`, {
    headers: {
      'x-k2-request': '1',
      'x-csrf-token': csrf.value,
      'idempotency-key': `e2e-close-${positionId}`,
    },
    data: { percentage: 50 },
  });
  expect(closed.status()).toBe(200);
  expect(await closed.json()).toMatchObject({
    state: 'OPEN',
    rejectReason: null,
    filledQuantity: '0.00000000',
  });
  const frozen = await request.get(`/k2-api/trading/positions?accountId=${ids.accountId}`);
  const held = (await frozen.json()) as {
    positions: { quantity: string; reservedSell: string }[];
  };
  expect(held.positions[0]).toMatchObject({ quantity: '2.00000000', reservedSell: '1.00000000' });
  const priced = await request.post('/k2-api/internal/test-fixture/quotes', {
    headers: {
      'x-k2-request': '1',
      'x-csrf-token': csrf.value,
    },
    data: {
      providerSymbol: ids.symbol.toLowerCase(),
      bid: '9.25',
      ask: '9.40',
      quoteUpdateId: '50',
    },
  });
  expect(priced.status()).toBe(202);
  const after = await request.get(`/k2-api/trading/positions?accountId=${ids.accountId}`);
  const remaining = (await after.json()) as {
    positions: { quantity: string; reservedSell: string }[];
  };
  expect(remaining.positions[0]).toMatchObject({
    quantity: '1.00000000',
    reservedSell: '0.00000000',
  });
});

async function fixtureAccount(userId: string): Promise<{
  accountId: string;
  instrumentId: string;
  symbol: string;
}> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const size = (43000 + (Number.parseInt(suffix.slice(0, 4), 16) % 400000)).toFixed(4);
    const product = await client.query<{ id: string }>(
      `INSERT INTO challenge_products (account_size, currency, active) VALUES ($1, 'USD', true) RETURNING id`,
      [size],
    );
    const price = await client.query<{ id: string }>(
      `INSERT INTO product_price_versions (product_id, price, currency, valid_from, decision_ref)
       VALUES ($1, 100, 'USD', now(), $2) RETURNING id`,
      [product.rows[0]?.id, `EP-${suffix}`],
    );
    const rules = await client.query<{ id: string }>(
      `INSERT INTO rule_sets (code, account_type) VALUES ($1, 'CHALLENGE') RETURNING id`,
      [`E2_${suffix}`.slice(0, 32).toUpperCase()],
    );
    const version = await client.query<{ id: string }>(
      `INSERT INTO rule_set_versions (rule_set_id, version_number, decision_ref, published_at)
       VALUES ($1, 1, $2, now()) RETURNING id`,
      [rules.rows[0]?.id, `ER-${suffix}`],
    );
    const evidence = await client.query<{ id: string }>(
      `INSERT INTO purchase_evidence_references (
         source_system, idempotency_key, external_reference, user_id, price_version_id, amount, currency, verified_at
       ) VALUES ('M-08', $1, $2, $3, $4, 100, 'USD', now()) RETURNING id`,
      [`ep-${suffix}`, `ex-${suffix}`, userId, price.rows[0]?.id],
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
      [accountId, `ep-act-${suffix}`],
    );
    await client.query(`UPDATE trading_accounts SET state = 'ACTIVE' WHERE id = $1`, [accountId]);
    const symbol = `E${suffix}`.slice(0, 16).toUpperCase();
    const instrument = await client.query<{ id: string }>(
      `INSERT INTO instruments (
         market, venue, symbol, provider_symbol, price_scale, quantity_scale, trading_status, quote_asset
       ) VALUES ('EQUITIES', 'NASDAQ', $1, $2, 2, 8, 'TRADABLE', 'USD') RETURNING id`,
      [symbol, symbol.toLowerCase()],
    );
    const instrumentId = instrument.rows[0]?.id ?? '';
    await client.query(
      `INSERT INTO quote_snapshots (
         instrument_id, bid, ask, bid_size, ask_size, source_timestamp, received_timestamp,
         processed_timestamp, sequence_no, provider_event_id, price_origin, feed_state
       ) VALUES ($1, 10, 10.1, 5, 5, now(), now(), now(), 1, '1', 'TEST_FIXTURE', 'LIVE')`,
      [instrumentId],
    );
    await client.query('COMMIT');
    return { accountId, instrumentId, symbol };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function insertOpenPosition(accountId: string, instrumentId: string): Promise<string> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const position = await pool.query<{ id: string }>(
      `INSERT INTO positions (account_id, instrument_id, status, quantity, average_entry, opened_at)
       VALUES ($1, $2, 'OPEN', 2, 10, now()) RETURNING id`,
      [accountId, instrumentId],
    );
    return position.rows[0]?.id ?? '';
  } finally {
    await pool.end();
  }
}
