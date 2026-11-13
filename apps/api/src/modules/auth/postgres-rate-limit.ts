import type pg from 'pg';

import type { RateDecision, RateLimiter } from './rate-limit.js';

/** Longest authentication window (registration, resend, forgot). Failures inside it stay. */
const DEFAULT_FAILURE_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;
const DEFAULT_CLEANUP_BATCH = 100;
/** Stable lock id so two API processes do not clean the same rows at once. */
const CLEANUP_LOCK_KEY = 8_720_211;

export type RateLimitCleanupOptions = {
  cleanupIntervalMs?: number;
  cleanupBatchSize?: number;
};

export type CleanupResult = {
  buckets: number;
  failures: number;
};

export class PostgresRateLimiter implements RateLimiter {
  private readonly cleanupIntervalMs: number;
  private readonly cleanupBatchSize: number;
  private failureRetentionMs = DEFAULT_FAILURE_RETENTION_MS;
  private lastCleanupAt = 0;

  constructor(
    private readonly pool: pg.Pool,
    options: RateLimitCleanupOptions = {},
  ) {
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.cleanupBatchSize = options.cleanupBatchSize ?? DEFAULT_CLEANUP_BATCH;
  }

  async consume(key: string, limit: number, windowMs: number): Promise<RateDecision> {
    this.scheduleCleanup();
    return this.transaction(async (client) => {
      const locked = await client.query<{ hit_count: number; reset_at: Date }>(
        `INSERT INTO rate_limit_buckets (bucket_key, hit_count, reset_at)
         VALUES ($1, 0, clock_timestamp())
         ON CONFLICT (bucket_key) DO UPDATE
           SET hit_count = rate_limit_buckets.hit_count
         RETURNING hit_count, reset_at`,
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
    this.noteFailureWindow(windowMs);
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
    this.noteFailureWindow(windowMs);
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
    this.noteFailureWindow(windowMs);
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

  /**
   * Deletes a bounded batch of expired buckets and failures older than the
   * longest observed window. Active windows are not selected. SKIP LOCKED
   * skips rows a request is updating. The advisory lock lets other processes
   * skip the batch instead of waiting.
   */
  async deleteExpiredBatch(): Promise<CleanupResult> {
    return this.transaction(async (client) => {
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1::bigint) AS locked',
        [CLEANUP_LOCK_KEY],
      );
      if (lock.rows[0]?.locked !== true) return { buckets: 0, failures: 0 };
      const buckets = await client.query(
        `WITH doomed AS (
           SELECT bucket_key
           FROM rate_limit_buckets
           WHERE reset_at <= clock_timestamp()
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         DELETE FROM rate_limit_buckets
         WHERE bucket_key IN (SELECT bucket_key FROM doomed)`,
        [this.cleanupBatchSize],
      );
      const failures = await client.query(
        `WITH doomed AS (
           SELECT id
           FROM rate_limit_failures
           WHERE occurred_at <= clock_timestamp() - ($2::text || ' milliseconds')::interval
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         DELETE FROM rate_limit_failures
         WHERE id IN (SELECT id FROM doomed)`,
        [this.cleanupBatchSize, String(this.failureRetentionMs)],
      );
      return {
        buckets: buckets.rowCount ?? 0,
        failures: failures.rowCount ?? 0,
      };
    });
  }

  private scheduleCleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanupAt < this.cleanupIntervalMs) return;
    this.lastCleanupAt = now;
    void this.deleteExpiredBatch().catch(() => undefined);
  }

  private noteFailureWindow(windowMs: number): void {
    if (Number.isFinite(windowMs) && windowMs > this.failureRetentionMs) {
      this.failureRetentionMs = windowMs;
    }
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
