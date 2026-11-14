import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/env.js';
import { loadEnvFile } from '../../src/config/load-env-file.js';
import { apiPackageRoot, resolveEnvFile } from '../../src/config/paths.js';
import { migrateDown, migrateUp, migrationStatus } from '../../src/infrastructure/db/migrator.js';
import { PgDatabaseProbe } from '../../src/infrastructure/db/probe.js';
import { createLogger } from '../../src/infrastructure/logging/logger.js';
import { startServer } from '../../src/server.js';
import { startWorker } from '../../src/worker.js';
import { validEnv } from '../valid-env.js';

const envFile = resolveEnvFile();
if (envFile) loadEnvFile(envFile);

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('Set TEST_DATABASE_URL to a database whose name ends with _test');
  }
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(
      'Refusing to run integration tests against a database whose name does not end with _test',
    );
  }
  return url;
}

const databaseUrl = testDatabaseUrl();
const password = decodeURIComponent(new URL(databaseUrl).password);
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

async function resetPublicSchema(): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query('GRANT ALL ON SCHEMA public TO public');
}

describe('database connectivity and migrations', () => {
  beforeAll(async () => {
    await resetPublicSchema();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('migrates up and down, then serves health from the real database', async () => {
    const directory = path.join(apiPackageRoot(), 'db', 'migrations');
    const lines: string[] = [];
    const logStream = {
      write(chunk: string) {
        lines.push(chunk);
      },
    };

    const before = await startServer(
      { ...process.env, DATABASE_URL: databaseUrl, PORT: '0', HOST: '127.0.0.1' },
      { logStream },
    );
    const beforeAddress = before.app.server.address();
    const beforePort = typeof beforeAddress === 'object' && beforeAddress ? beforeAddress.port : 0;
    const unmigrated = await fetch(`http://127.0.0.1:${beforePort}/health`);
    expect(unmigrated.status).toBe(503);
    const unmigratedBody: unknown = await unmigrated.json();
    expect(unmigratedBody).toMatchObject({
      status: 'degraded',
      checks: { database: { status: 'up', schemaVersion: null } },
    });
    await before.app.close();

    const applied = await migrateUp(pool, directory);
    expect(applied).toEqual(['0001', '0002', '0003', '0004', '0005', '0006']);
    expect(await migrateUp(pool, directory)).toEqual([]);
    const status = await migrationStatus(pool, directory);
    expect(status.map((entry) => entry.version)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
    ]);
    expect(status.every((entry) => entry.state === 'applied')).toBe(true);

    const runtime = await startServer(
      { ...process.env, DATABASE_URL: databaseUrl, PORT: '0', HOST: '127.0.0.1' },
      { logStream },
    );
    const address = runtime.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const bodyText = await response.text();
    expect(response.status).toBe(200);
    expect(bodyText).toContain('"schemaVersion":"0001"');
    expect(bodyText).not.toContain(password);
    expect(lines.join('')).not.toContain(password);
    await runtime.app.close();

    const worker = await startWorker({
      ...process.env,
      DATABASE_URL: databaseUrl,
    });
    await worker.close();

    expect(await migrateDown(pool, directory)).toBe('0006');
    const tradingGone = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'liquidity_levels'",
    );
    expect(tradingGone.rowCount).toBe(0);
    expect(await migrateDown(pool, directory)).toBe('0005');
    expect(await migrateDown(pool, directory)).toBe('0004');
    expect(await migrateDown(pool, directory)).toBe('0003');
    expect(await migrateDown(pool, directory)).toBe('0002');
    const identity = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'",
    );
    expect(identity.rowCount).toBe(0);
    expect(await migrateDown(pool, directory)).toBe('0001');
    const tables = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    expect(tables.rows.map((row) => row.table_name).sort()).toEqual(['schema_migrations']);
    expect(await migrateUp(pool, directory)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
    ]);
  });

  it('rolls migration 0006 back and applies it again', async () => {
    const directory = path.join(apiPackageRoot(), 'db', 'migrations');
    await migrateUp(pool, directory);
    expect(await migrateDown(pool, directory)).toBe('0006');
    const dropped = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'orders'",
    );
    expect(dropped.rowCount).toBe(0);
    const column = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'instruments' AND column_name = 'trading_status'",
    );
    expect(column.rowCount).toBe(0);
    expect(await migrateUp(pool, directory)).toEqual(['0006']);

    const instrument = await pool.query<{ id: string }>(
      `INSERT INTO instruments (
         market, venue, symbol, provider_symbol, price_scale, quantity_scale, quote_asset
       ) VALUES ('CRYPTO', 'BINANCE_SPOT', 'BTCUSDT', 'btcusdt', 2, 8, 'USDT')
       RETURNING id`,
    );
    const instrumentId = instrument.rows[0]?.id;
    if (!instrumentId) throw new Error('instrument insert returned no id');
    const status = await pool.query<{ trading_status: string }>(
      'SELECT trading_status FROM instruments WHERE id = $1',
      [instrumentId],
    );
    expect(status.rows[0]?.trading_status).toBe('DISABLED');
    await pool.query(
      `INSERT INTO instrument_quote_cursors (instrument_id, source, last_update_id)
       VALUES ($1, 'test-fixture', '10')`,
      [instrumentId],
    );
    await pool.query(
      `INSERT INTO liquidity_levels (
         instrument_id, source, book_side, price, quote_update_id, displayed_qty, consumed_qty
       ) VALUES ($1, 'test-fixture', 'ASK', 100, '10', 0.5, 0.2)`,
      [instrumentId],
    );
    const level = await pool.query<{ displayed_qty: string; consumed_qty: string }>(
      `SELECT displayed_qty::text, consumed_qty::text
       FROM liquidity_levels WHERE instrument_id = $1`,
      [instrumentId],
    );
    expect(level.rows[0]?.displayed_qty).toBe('0.50000000');
    expect(level.rows[0]?.consumed_qty).toBe('0.20000000');
    const sequence = await pool.query<{ next: string }>(
      "SELECT nextval('order_accept_sequence')::text AS next",
    );
    expect(Number(sequence.rows[0]?.next)).toBeGreaterThan(0);
  });

  it('rolls back a failed migration and refuses a changed checksum', async () => {
    await resetPublicSchema();
    const dir = mkdtempSync(path.join(tmpdir(), 'k2-int-mig-'));
    const upPath = path.join(dir, '0099_probe.up.sql');
    const downPath = path.join(dir, '0099_probe.down.sql');
    const originalUp = 'CREATE TABLE probe_ok (id int);\nINSERT INTO probe_ok VALUES (1);';
    writeFileSync(upPath, originalUp);
    writeFileSync(downPath, 'DROP TABLE IF EXISTS probe_ok;');
    await migrateUp(pool, dir);

    const brokenDir = mkdtempSync(path.join(tmpdir(), 'k2-int-bad-'));
    writeFileSync(path.join(brokenDir, '0099_probe.up.sql'), originalUp);
    writeFileSync(path.join(brokenDir, '0099_probe.down.sql'), 'DROP TABLE IF EXISTS probe_ok;');
    writeFileSync(
      path.join(brokenDir, '0100_bad.up.sql'),
      "CREATE TABLE probe_bad (id int); INSERT INTO probe_bad VALUES ('nope');",
    );
    writeFileSync(path.join(brokenDir, '0100_bad.down.sql'), 'DROP TABLE IF EXISTS probe_bad;');
    await expect(migrateUp(pool, brokenDir)).rejects.toThrow();
    const leftover = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'probe_bad'",
    );
    expect(leftover.rowCount).toBe(0);

    writeFileSync(upPath, 'CREATE TABLE probe_ok (id int);\nINSERT INTO probe_ok VALUES (2);');
    await expect(migrateUp(pool, dir)).rejects.toThrow(/Checksum mismatch/);
    const still = await pool.query<{ id: number }>('SELECT id FROM probe_ok');
    expect(still.rows[0]?.id).toBe(1);
    expect(readFileSync(upPath, 'utf8')).toContain('VALUES (2)');
  });

  it('runs the migration CLI against the test database', async () => {
    await resetPublicSchema();
    await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
    const result = spawnSync('tsx', ['src/infrastructure/db/migrate-cli.ts', 'status'], {
      cwd: apiPackageRoot(),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('0001');
    expect(`${result.stdout}${result.stderr}`).not.toContain(password);
  });

  it('fails readiness for a missing migration, a bad checksum, a wrong marker, or a dead database', async () => {
    await resetPublicSchema();
    const directory = path.join(apiPackageRoot(), 'db', 'migrations');
    expect(await migrateUp(pool, directory)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
      '0005',
      '0006',
    ]);
    expect(await migrateUp(pool, directory)).toEqual([]);

    const healthy = await listen();
    expect(healthy.status).toBe(200);
    expect(healthy.body).toMatchObject({
      status: 'ok',
      checks: { database: { status: 'up', schemaVersion: '0001' } },
    });

    const removed = await pool.query<{ version: string; name: string; checksum: string }>(
      `DELETE FROM schema_migrations WHERE version = '0005' RETURNING version, name, checksum`,
    );
    const removedRow = removed.rows[0];
    if (!removedRow) throw new Error('deleted migration row was not returned');
    expect(removedRow.version).toBe('0005');
    const missing = await listen();
    expect(missing.status).toBe(503);
    expect(missing.body).toMatchObject({
      status: 'degraded',
      checks: { database: { status: 'up', schemaVersion: '0001' } },
    });
    await pool.query(
      `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
      [removedRow.version, removedRow.name, removedRow.checksum],
    );

    const original = await pool.query<{ checksum: string }>(
      `SELECT checksum FROM schema_migrations WHERE version = '0004'`,
    );
    await pool.query(`UPDATE schema_migrations SET checksum = $1 WHERE version = '0004'`, [
      'ab'.repeat(32),
    ]);
    const tampered = await listen();
    expect(tampered.status).toBe(503);
    expect(tampered.body).toMatchObject({
      checks: { database: { status: 'up', schemaVersion: '0001' } },
    });
    await pool.query(`UPDATE schema_migrations SET checksum = $1 WHERE version = '0004'`, [
      original.rows[0]?.checksum,
    ]);

    await pool.query(`UPDATE foundation_schema_info SET schema_version = '9999' WHERE id = 1`);
    const wrongMarker = await listen();
    expect(wrongMarker.status).toBe(503);
    expect(wrongMarker.body).toMatchObject({
      status: 'degraded',
      checks: { database: { status: 'up', schemaVersion: '9999' } },
    });
    await pool.query(`UPDATE foundation_schema_info SET schema_version = '0001' WHERE id = 1`);
    const restored = await listen();
    expect(restored.status).toBe(200);

    const badUrl = new URL(databaseUrl);
    badUrl.port = '1';
    const badPool = new pg.Pool({
      connectionString: badUrl.toString(),
      connectionTimeoutMillis: 1_000,
      max: 1,
    });
    const discarded: string[] = [];
    const down = await new PgDatabaseProbe(
      badPool,
      createLogger(loadConfig(validEnv()), {
        write(chunk: string) {
          discarded.push(chunk);
        },
      }),
    ).check();
    expect(down.reachable).toBe(false);
    expect(down.migrated).toBe(false);
    expect(discarded.join('')).not.toContain(password);
    await badPool.end();
  });
});

async function listen(): Promise<{ status: number; body: unknown }> {
  const runtime = await startServer(
    validEnv({ DATABASE_URL: databaseUrl, PORT: '0', HOST: '127.0.0.1' }),
    {
      logStream: {
        write() {
          /* discard */
        },
      },
    },
  );
  try {
    const address = runtime.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return { status: response.status, body: await response.json() };
  } finally {
    await runtime.app.close();
  }
}
