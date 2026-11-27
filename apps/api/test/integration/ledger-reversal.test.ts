import { randomUUID } from 'node:crypto';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiPackageRoot } from '../../src/config/paths.js';
import { migrateUp } from '../../src/infrastructure/db/migrator.js';
import { postedCash } from '../../src/modules/ledger/drain.js';
import { postReversal } from '../../src/modules/ledger/reversal.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a database whose name ends with _test');
if (!new URL(databaseUrl).pathname.replace(/^\//, '').endsWith('_test')) {
  throw new Error(
    'Refusing to run integration tests against a database whose name does not end with _test',
  );
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

describe('ledger reversal on postgres', () => {
  beforeAll(async () => {
    await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('adds the opposite row and leaves the original amount', async () => {
    const accountId = await makeAccount();
    const original = await pool.query<{ id: string }>(
      `INSERT INTO journal_entries (
         account_id, entry_type, amount, cash_effect, idempotency_key, actor_type
       ) VALUES ($1, 'FILL', -10, true, $2, 'SYSTEM')
       RETURNING id`,
      [accountId, `fill:${accountId}`],
    );
    const originalId = original.rows[0]?.id ?? '';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const reversalId = await postReversal(client, originalId, 'SUPER_ADMIN');
      expect(reversalId).toBeTruthy();
      expect(await postReversal(client, originalId, 'SUPER_ADMIN')).toBeNull();
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const rows = await pool.query<{ entry_type: string; amount: string; actor_type: string }>(
      `SELECT entry_type, amount::text, actor_type
       FROM journal_entries WHERE account_id = $1 ORDER BY entry_type`,
      [accountId],
    );
    expect(rows.rows).toEqual([
      { entry_type: 'FILL', amount: '-10.0000', actor_type: 'SYSTEM' },
      { entry_type: 'REVERSAL', amount: '10.0000', actor_type: 'SUPER_ADMIN' },
    ]);
    const reader = await pool.connect();
    try {
      expect(await postedCash(reader, accountId)).toBe('0.0000');
    } finally {
      reader.release();
    }
  });
});

async function makeAccount(): Promise<string> {
  const client = await pool.connect();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>(
      'INSERT INTO users (email) VALUES ($1) RETURNING id',
      [`rev-${suffix}@example.com`],
    );
    const userId = required(user.rows[0]?.id);
    const picked = 26000 + (Number.parseInt(suffix.slice(0, 4), 16) % 700000);
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
       ) VALUES ($1, 'CHALLENGE', 'STAGE_1', 'ACTIVE', 10000, 'USD', $2, $3, $4, $5, now())
       RETURNING id`,
      [userId, productId, priceId, versionId, required(evidence.rows[0]?.id)],
    );
    await client.query('COMMIT');
    return required(account.rows[0]?.id);
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
