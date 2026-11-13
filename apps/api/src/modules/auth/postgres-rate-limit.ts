import type pg from 'pg';

import type { RateDecision, RateLimiter } from './rate-limit.js';

export class PostgresRateLimiter implements RateLimiter {
  constructor(private readonly pool: pg.Pool) {}

  async consume(key: string, limit: number, windowMs: number): Promise<RateDecision> {
    return this.transaction(async (client) => {
      await client.query(
        `INSERT INTO rate_limit_buckets (bucket_key, hit_count, reset_at)
         VALUES ($1, 0, clock_timestamp())
         ON CONFLICT (bucket_key) DO NOTHING`,
        [key],
      );
      const locked = await client.query<{ hit_count: number; reset_at: Date }>(
        `SELECT hit_count, reset_at
         FROM rate_limit_buckets
         WHERE bucket_key = $1
         FOR UPDATE`,
        [key],
      );
      const row = locked.rows[0];
      if (!row) throw new Error('Rate limit bucket was not created');
      const open = await client.query<{ expired: boolean; retry_after: number }>(
        `SELECT $1::timestamptz <= clock_timestamp() AS expired,
                GREATEST(
                  1,
                  CEIL(EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp())))
                )::int AS retry_after`,
        [row.reset_at],
      );
      const state = open.rows[0];
      if (!state) throw new Error('Rate limit clock read failed');
      if (state.expired || row.hit_count === 0) {
        await client.query(
          `UPDATE rate_limit_buckets
           SET hit_count = 1,
               reset_at = clock_timestamp() + ($2::text || ' milliseconds')::interval
           WHERE bucket_key = $1`,
          [key, String(windowMs)],
        );
        return { ok: true };
      }
      if (row.hit_count >= limit) {
        return { ok: false, retryAfterSeconds: state.retry_after };
      }
      await client.query(
        `UPDATE rate_limit_buckets SET hit_count = hit_count + 1 WHERE bucket_key = $1`,
        [key],
      );
      return { ok: true };
    });
  }

  async failureCount(key: string, windowMs: number): Promise<number> {
    const result = await this.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM rate_limit_failures
       WHERE bucket_key = $1
         AND occurred_at > clock_timestamp() - ($2::text || ' milliseconds')::interval`,
      [key, String(windowMs)],
    );
    return result.rows[0]?.count ?? 0;
  }

  async recordFailure(key: string, windowMs: number): Promise<number> {
    return this.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`fail:${key}`]);
      await client.query(
        `DELETE FROM rate_limit_failures
         WHERE bucket_key = $1
           AND occurred_at <= clock_timestamp() - ($2::text || ' milliseconds')::interval`,
        [key, String(windowMs)],
      );
      await client.query(
        `INSERT INTO rate_limit_failures (bucket_key, occurred_at)
         VALUES ($1, clock_timestamp())`,
        [key],
      );
      const result = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM rate_limit_failures WHERE bucket_key = $1`,
        [key],
      );
      return result.rows[0]?.count ?? 0;
    });
  }

  async oldestFailureAgeMs(key: string, windowMs: number): Promise<number | null> {
    const result = await this.pool.query<{ age_ms: number | null }>(
      `SELECT FLOOR(
           EXTRACT(EPOCH FROM (clock_timestamp() - min(occurred_at))) * 1000
         )::int AS age_ms
       FROM rate_limit_failures
       WHERE bucket_key = $1
         AND occurred_at > clock_timestamp() - ($2::text || ' milliseconds')::interval`,
      [key, String(windowMs)],
    );
    return result.rows[0]?.age_ms ?? null;
  }

  async clearFailures(key: string): Promise<void> {
    await this.pool.query(`DELETE FROM rate_limit_failures WHERE bucket_key = $1`, [key]);
  }

  private async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
