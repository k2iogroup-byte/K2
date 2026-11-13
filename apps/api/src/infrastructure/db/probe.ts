import type pg from 'pg';
import type { Logger } from 'pino';

export type DatabaseCheckResult = {
  reachable: boolean;
  migrated: boolean;
  latencyMs: number;
  schemaVersion: string | null;
};

export interface DatabaseProbe {
  check(): Promise<DatabaseCheckResult>;
}

export class PgDatabaseProbe implements DatabaseProbe {
  constructor(
    private readonly pool: pg.Pool,
    private readonly logger: Logger,
  ) {}

  async check(): Promise<DatabaseCheckResult> {
    const started = performance.now();
    try {
      await this.pool.query('SELECT 1');
      try {
        const result = await this.pool.query<{ schema_version: string }>(
          'SELECT schema_version FROM foundation_schema_info WHERE id = 1',
        );
        const schemaVersion = result.rows[0]?.schema_version ?? null;
        return {
          reachable: true,
          migrated: schemaVersion !== null,
          latencyMs: elapsed(started),
          schemaVersion,
        };
      } catch (error) {
        if (isUndefinedTable(error)) {
          return {
            reachable: true,
            migrated: false,
            latencyMs: elapsed(started),
            schemaVersion: null,
          };
        }
        throw error;
      }
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
