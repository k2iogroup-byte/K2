import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiPackageRoot } from '../../src/config/paths.js';
import { migrateUp } from '../../src/infrastructure/db/migrator.js';
import { PostgresRateLimiter } from '../../src/modules/auth/postgres-rate-limit.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a database whose name ends with _test');
if (!new URL(databaseUrl).pathname.replace(/^\//, '').endsWith('_test')) {
  throw new Error(
    'Refusing to run integration tests against a database whose name does not end with _test',
  );
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

async function reset(): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query('GRANT ALL ON SCHEMA public TO public');
  await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
}

async function buckets(prefix: string): Promise<{ key: string; hits: number }[]> {
  const result = await pool.query<{ bucket_key: string; hit_count: number }>(
    `SELECT bucket_key, hit_count
     FROM rate_limit_buckets
     WHERE bucket_key LIKE $1
     ORDER BY bucket_key`,
    [`${prefix}%`],
  );
  return result.rows.map((row) => ({ key: row.bucket_key, hits: row.hit_count }));
}

describe('postgres rate-limit cleanup', () => {
  beforeAll(async () => {
    await reset();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('deletes only expired rows, in bounded batches, without disturbing an open window', async () => {
    const limiter = new PostgresRateLimiter(pool, { cleanupBatchSize: 2 });
    await pool.query(
      `INSERT INTO rate_limit_buckets (bucket_key, hit_count, reset_at) VALUES
         ('expired-a', 3, clock_timestamp() - interval '1 minute'),
         ('expired-b', 3, clock_timestamp() - interval '2 minutes'),
         ('expired-c', 3, clock_timestamp() - interval '3 minutes'),
         ('expired-d', 3, clock_timestamp() - interval '4 minutes'),
         ('expired-e', 3, clock_timestamp() - interval '5 minutes'),
         ('active-window', 4, clock_timestamp() + interval '10 minutes')`,
    );
    await pool.query(
      `INSERT INTO rate_limit_failures (bucket_key, occurred_at) VALUES
         ('fail-old', clock_timestamp() - interval '2 hours'),
         ('fail-recent', clock_timestamp() - interval '30 minutes'),
         ('fail-fresh', clock_timestamp() - interval '1 minute')`,
    );

    const first = await limiter.deleteExpiredBatch();
    expect(first.buckets).toBe(2);
    expect((await buckets('expired-')).length).toBe(3);
    expect(await buckets('active-')).toEqual([{ key: 'active-window', hits: 4 }]);

    expect((await limiter.deleteExpiredBatch()).buckets).toBe(2);
    expect((await limiter.deleteExpiredBatch()).buckets).toBe(1);
    expect(await buckets('expired-')).toEqual([]);
    expect(await buckets('active-')).toEqual([{ key: 'active-window', hits: 4 }]);

    const ages = await pool.query<{ bucket_key: string }>(
      `SELECT bucket_key FROM rate_limit_failures ORDER BY bucket_key`,
    );
    expect(ages.rows.map((row) => row.bucket_key)).toEqual(['fail-fresh', 'fail-recent']);
    expect(await limiter.failureCount('fail-fresh', 60 * 60 * 1000)).toBe(1);
    expect(await limiter.failureCount('fail-old', 60 * 60 * 1000)).toBe(0);

    expect((await limiter.consume('active-window', 5, 60_000)).ok).toBe(true);
    expect((await limiter.consume('active-window', 5, 60_000)).ok).toBe(false);
  });

  it('skips rows locked by another session and stays safe across two cleaners', async () => {
    const left = new PostgresRateLimiter(pool, { cleanupBatchSize: 100 });
    const right = new PostgresRateLimiter(pool, { cleanupBatchSize: 100 });
    await pool.query(
      `INSERT INTO rate_limit_buckets (bucket_key, hit_count, reset_at) VALUES
         ('locked-expired', 2, clock_timestamp() - interval '1 minute'),
         ('free-expired', 2, clock_timestamp() - interval '1 minute'),
         ('still-active', 2, clock_timestamp() + interval '5 minutes')`,
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT bucket_key FROM rate_limit_buckets WHERE bucket_key = 'locked-expired' FOR UPDATE`,
      );
      await left.deleteExpiredBatch();
      const held = await client.query(
        `SELECT bucket_key FROM rate_limit_buckets WHERE bucket_key = 'locked-expired'`,
      );
      expect(held.rowCount).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await buckets('free-expired')).toEqual([]);
    expect(await buckets('still-active')).toEqual([{ key: 'still-active', hits: 2 }]);

    await pool.query(
      `INSERT INTO rate_limit_buckets (bucket_key, hit_count, reset_at)
       SELECT 'batch-' || n, 1, clock_timestamp() - interval '1 minute'
       FROM generate_series(1, 10) AS n
       ON CONFLICT (bucket_key) DO NOTHING`,
    );
    await Promise.all([left.deleteExpiredBatch(), right.deleteExpiredBatch()]);
    expect(await buckets('batch-')).toEqual([]);
    expect(await buckets('locked-expired')).toEqual([]);
    expect(await buckets('still-active')).toEqual([{ key: 'still-active', hits: 2 }]);

    for (let attempt = 0; attempt < 25; attempt += 1) {
      await pool.query(`DELETE FROM rate_limit_buckets WHERE bucket_key = 'race'`);
      await pool.query(
        `INSERT INTO rate_limit_buckets (bucket_key, hit_count, reset_at)
         VALUES ('race', 9, clock_timestamp() - interval '1 second')`,
      );
      await Promise.all([left.consume('race', 5, 60_000), right.deleteExpiredBatch()]);
    }
    const afterRace = await left.consume('race', 5, 60_000);
    expect(afterRace.ok).toBe(true);
  });

  it('cleans opportunistically and does not run again inside the interval', async () => {
    const limiter = new PostgresRateLimiter(pool, {
      cleanupIntervalMs: 60_000,
      cleanupBatchSize: 50,
    });
    await pool.query(
      `INSERT INTO rate_limit_buckets (bucket_key, hit_count, reset_at)
       VALUES ('opportunistic-old', 1, clock_timestamp() - interval '1 minute')`,
    );
    await limiter.consume('opportunistic-live', 5, 60_000);
    await waitFor(async () => (await buckets('opportunistic-old')).length === 0);
    expect(await buckets('opportunistic-live')).toEqual([{ key: 'opportunistic-live', hits: 1 }]);

    await pool.query(
      `INSERT INTO rate_limit_buckets (bucket_key, hit_count, reset_at)
       VALUES ('opportunistic-later', 1, clock_timestamp() - interval '1 minute')`,
    );
    await limiter.consume('opportunistic-live', 5, 60_000);
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(await buckets('opportunistic-later')).toEqual([{ key: 'opportunistic-later', hits: 1 }]);
    await limiter.deleteExpiredBatch();
    expect(await buckets('opportunistic-later')).toEqual([]);
    expect((await limiter.consume('opportunistic-live', 5, 60_000)).ok).toBe(true);
  });
});

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 2_000) {
    if (await predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error('timed out waiting for rate-limit cleanup');
}
