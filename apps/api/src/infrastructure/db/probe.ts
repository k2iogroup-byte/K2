import type pg from 'pg';
import type { Logger } from 'pino';

import { migrationsDirectory } from '../../config/paths.js';
import { loadMigrations } from './migrator.js';

/**
 * Migration 0001 writes this marker and later migrations leave it unchanged.
 * Readiness does not trust the marker alone. `schema_migrations` is the record
 * of which files actually ran, including their checksums.
 */
export const EXPECTED_FOUNDATION_SCHEMA_VERSION = '0001';

export type DatabaseCheckResult = {
  reachable: boolean;
  migrated: boolean;
  latencyMs: number;
  schemaVersion: string | null;
};

export type RequiredMigration = {
  version: string;
  checksum: string;
};

export interface DatabaseProbe {
  check(): Promise<DatabaseCheckResult>;
}

let cachedRequired: readonly RequiredMigration[] | null = null;

export function requiredSchemaMigrations(): readonly RequiredMigration[] {
  cachedRequired ??= loadMigrations(migrationsDirectory()).map((migration) => ({
    version: migration.version,
    checksum: migration.checksum,
  }));
  return cachedRequired;
}

export function migrationsAreReady(
  schemaVersion: string | null,
  applied: readonly RequiredMigration[],
  required: readonly RequiredMigration[],
): boolean {
  if (schemaVersion !== EXPECTED_FOUNDATION_SCHEMA_VERSION) return false;
  if (required.length === 0 || applied.length !== required.length) return false;
  const seen = new Map<string, string>();
  for (const row of applied) {
    if (seen.has(row.version)) return false;
    seen.set(row.version, row.checksum);
  }
  return required.every((migration) => seen.get(migration.version) === migration.checksum);
}

export class PgDatabaseProbe implements DatabaseProbe {
  private readonly required: readonly RequiredMigration[];

  constructor(
    private readonly pool: pg.Pool,
    private readonly logger: Logger,
    required?: readonly RequiredMigration[],
  ) {
    this.required = required ?? requiredSchemaMigrations();
  }

  async check(): Promise<DatabaseCheckResult> {
    const started = performance.now();
    try {
      await this.pool.query('SELECT 1');
      const schemaVersion = await this.readSchemaVersion();
      if (schemaVersion === undefined) {
        return {
          reachable: true,
          migrated: false,
          latencyMs: elapsed(started),
          schemaVersion: null,
        };
      }
      const applied = await this.readAppliedMigrations();
      if (applied === null) {
        return {
          reachable: true,
          migrated: false,
          latencyMs: elapsed(started),
          schemaVersion,
        };
      }
      return {
        reachable: true,
        migrated: migrationsAreReady(schemaVersion, applied, this.required),
        latencyMs: elapsed(started),
        schemaVersion,
      };
    } catch (error) {
      this.logger.error(
        { event: 'database_probe_failed', pgCode: pgCode(error) },
        'database probe failed',
      );
      return {
        reachable: false,
        migrated: false,
        latencyMs: elapsed(started),
        schemaVersion: null,
      };
    }
  }

  private async readSchemaVersion(): Promise<string | null | undefined> {
    try {
      const result = await this.pool.query<{ schema_version: string }>(
        'SELECT schema_version FROM foundation_schema_info WHERE id = 1',
      );
      return result.rows[0]?.schema_version ?? null;
    } catch (error) {
      if (isUndefinedTable(error)) return undefined;
      throw error;
    }
  }

  private async readAppliedMigrations(): Promise<RequiredMigration[] | null> {
    try {
      const result = await this.pool.query<RequiredMigration>(
        'SELECT version, checksum FROM schema_migrations',
      );
      return result.rows;
    } catch (error) {
      if (isUndefinedTable(error)) return null;
      throw error;
    }
  }
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function isUndefinedTable(error: unknown): boolean {
  return pgCode(error) === '42P01';
}

function pgCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    if (typeof code === 'string') return code;
  }
  return 'UNKNOWN';
}
