import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { apiPackageRoot } from '../../src/config/paths.js';
import { migrateUp } from '../../src/infrastructure/db/migrator.js';
import { PgDatabaseProbe } from '../../src/infrastructure/db/probe.js';
import { createLogger } from '../../src/infrastructure/logging/logger.js';
import { CaptureEmailSender } from '../../src/modules/auth/email.js';
import { PostgresRateLimiter } from '../../src/modules/auth/postgres-rate-limit.js';
import { validEnv } from '../valid-env.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a database whose name ends with _test');
if (!new URL(databaseUrl).pathname.replace(/^\//, '').endsWith('_test')) {
  throw new Error(
    'Refusing to run integration tests against a database whose name does not end with _test',
  );
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

async function keys(): Promise<{ key: string; hits: number }[]> {
  const result = await pool.query<{ bucket_key: string; hit_count: number }>(
    `SELECT bucket_key, hit_count FROM rate_limit_buckets WHERE bucket_key LIKE 'login-ip:%' ORDER BY bucket_key`,
  );
  return result.rows.map((row) => ({ key: row.bucket_key, hits: row.hit_count }));
}

describe('rate limits use the resolved client address', () => {
  beforeAll(async () => {
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await pool.query('GRANT ALL ON SCHEMA public TO public');
    await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('keeps two users behind one proxy in different buckets and ignores a forged prefix', async () => {
    const app = await boot('1');
    await login(app, '10.0.0.8', '203.0.113.10');
    await login(app, '10.0.0.8', '198.51.100.4, 203.0.113.11');
    await login(app, '10.0.0.8', '198.51.100.99, 203.0.113.10');
    await login(app, '10.0.0.8', 'not-an-ip');
    await login(app, 'fd00::1', '2001:db8::10');
    await login(app, '10.0.0.8', '::ffff:203.0.113.20');
    expect(await keys()).toEqual([
      { key: 'login-ip:2001:db8::10', hits: 1 },
      { key: 'login-ip:203.0.113.10', hits: 2 },
      { key: 'login-ip:203.0.113.11', hits: 1 },
      { key: 'login-ip:203.0.113.20', hits: 1 },
      { key: 'login-ip:unknown', hits: 1 },
    ]);
    const audit = await pool.query<{ ip: string | null }>(
      `SELECT ip FROM authentication_audit_events WHERE event_type = 'login.failed' ORDER BY created_at`,
    );
    expect(audit.rows.map((row) => row.ip)).toEqual([
      '203.0.113.10',
      '203.0.113.11',
      '203.0.113.10',
      null,
      '2001:db8::10',
      '203.0.113.20',
    ]);
    await app.close();

    await pool.query(`DELETE FROM rate_limit_buckets`);
    const direct = await boot('false');
    await login(direct, '192.0.2.40', '203.0.113.10, 198.51.100.8');
    expect(await keys()).toEqual([{ key: 'login-ip:192.0.2.40', hits: 1 }]);
    await direct.close();
  });
});

async function boot(trustProxy: string): Promise<Awaited<ReturnType<typeof buildApp>>> {
  const config = loadConfig(
    validEnv({
      DATABASE_URL: databaseUrl,
      TRUST_PROXY: trustProxy,
      PORT: '0',
      HOST: '127.0.0.1',
      AUTH_LOGIN_DELAY_BASE_MS: '0',
      AUTH_LOGIN_DELAY_CAP_MS: '0',
      EMAIL_DELIVERY: 'capture',
    }),
  );
  return buildApp({
    config,
    pool,
    emailSender: new CaptureEmailSender(null),
    limiter: new PostgresRateLimiter(pool, { cleanupIntervalMs: 3_600_000 }),
    database: new PgDatabaseProbe(pool, createLogger(config)),
    logger: false,
  });
}

async function login(
  app: Awaited<ReturnType<typeof buildApp>>,
  remoteAddress: string,
  forwardedFor: string,
): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress,
    headers: {
      'content-type': 'application/json',
      'x-k2-request': '1',
      'x-forwarded-for': forwardedFor,
    },
    payload: { email: 'nobody@example.com', password: 'not-the-password' },
  });
  expect(response.statusCode).toBe(401);
}
