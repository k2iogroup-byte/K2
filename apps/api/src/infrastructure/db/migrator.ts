import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type pg from 'pg';

const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;

export type Migration = {
  version: string;
  name: string;
  upSql: string;
  downSql: string;
  checksum: string;
};

export type MigrationStatus = {
  version: string;
  name: string;
  state: 'applied' | 'pending';
  appliedAt: string | null;
};

type AppliedRow = {
  version: string;
  checksum: string;
  applied_at: Date;
};

export function migrationChecksum(upSql: string): string {
  return createHash('sha256').update(upSql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export function loadMigrations(directory: string): Migration[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    throw new Error('Migrations directory not found');
  }
  const grouped = new Map<
    string,
    { version: string; name: string; upSql?: string; downSql?: string }
  >();
  for (const fileName of names) {
    const match = FILE_NAME.exec(fileName);
    if (!match) {
      throw new Error(`Unexpected file in migrations directory: ${fileName}`);
    }
    const version = match[1];
    const name = match[2];
    const direction = match[3];
    if (!version || !name || (direction !== 'up' && direction !== 'down')) {
      throw new Error(`Unexpected file in migrations directory: ${fileName}`);
    }
    const key = `${version}_${name}`;
    const current = grouped.get(key) ?? { version, name };
    const sql = readFileSync(path.join(directory, fileName), 'utf8');
    if (direction === 'up') current.upSql = sql;
    else current.downSql = sql;
    grouped.set(key, current);
  }
  const migrations = [...grouped.values()]
    .sort((left, right) => left.version.localeCompare(right.version))
    .map((entry) => {
      if (!entry.upSql || !entry.downSql) {
        throw new Error(`Migration ${entry.version}_${entry.name} is missing an up or down file`);
      }
      return {
        version: entry.version,
        name: entry.name,
        upSql: entry.upSql,
        downSql: entry.downSql,
        checksum: migrationChecksum(entry.upSql),
      };
    });
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.version)) {
      throw new Error(`Duplicate migration version ${migration.version}`);
    }
    seen.add(migration.version);
  }
  return migrations;
}

export async function migrateUp(pool: pg.Pool, directory: string): Promise<readonly string[]> {
  const migrations = loadMigrations(directory);
  const client = await pool.connect();
  const appliedVersions: string[] = [];
  try {
    await client.query('BEGIN');
    await ensureMigrationsTable(client);
    const applied = await readApplied(client);
    for (const migration of migrations) {
      const existing = applied.get(migration.version);
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new Error(
            `Checksum mismatch for migration ${migration.version}. Applied migrations are immutable.`,
          );
        }
        continue;
      }
      await client.query(migration.upSql);
      await client.query(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, migration.checksum],
      );
      appliedVersions.push(migration.version);
    }
    await client.query('COMMIT');
    return appliedVersions;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function migrateDown(pool: pg.Pool, directory: string): Promise<string | null> {
  const migrations = loadMigrations(directory);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureMigrationsTable(client);
    const latest = await client.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
    );
    const version = latest.rows[0]?.version;
    if (!version) {
      await client.query('COMMIT');
      return null;
    }
    const migration = migrations.find((entry) => entry.version === version);
    if (!migration) {
      throw new Error(`Applied migration ${version} has no down file in the migrations directory`);
    }
    await client.query(migration.downSql);
    await client.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
    await client.query('COMMIT');
    return version;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function migrationStatus(
  pool: pg.Pool,
  directory: string,
): Promise<readonly MigrationStatus[]> {
  const migrations = loadMigrations(directory);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureMigrationsTable(client);
    const applied = await readApplied(client);
    await client.query('COMMIT');
    return migrations.map((migration) => {
      const row = applied.get(migration.version);
      return {
        version: migration.version,
        name: migration.name,
        state: row ? 'applied' : 'pending',
        appliedAt: row ? row.applied_at.toISOString() : null,
      };
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function ensureMigrationsTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function readApplied(client: pg.PoolClient): Promise<Map<string, AppliedRow>> {
  const result = await client.query<AppliedRow>(
    'SELECT version, checksum, applied_at FROM schema_migrations',
  );
  return new Map(result.rows.map((row) => [row.version, row]));
}
