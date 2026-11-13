import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnvFile } from '../../src/config/load-env-file.js';
import { apiPackageRoot, resolveEnvFile } from '../../src/config/paths.js';
import { migrateDown, migrateUp, migrationStatus } from '../../src/infrastructure/db/migrator.js';
import { startServer } from '../../src/server.js';
import { startWorker } from '../../src/worker.js';

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
    expect(applied).toEqual(['0001']);
    expect(await migrateUp(pool, directory)).toEqual([]);
    const status = await migrationStatus(pool, directory);
    expect(status[0]).toMatchObject({ version: '0001', state: 'applied' });

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

    expect(await migrateDown(pool, directory)).toBe('0001');
    const tables = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    expect(tables.rows.map((row) => row.table_name).sort()).toEqual(['schema_migrations']);
    expect(await migrateUp(pool, directory)).toEqual(['0001']);
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
});
