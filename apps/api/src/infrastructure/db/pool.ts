import pg from 'pg';
import type { Logger } from 'pino';

import type { AppConfig } from '../../config/env.js';

export function createPool(config: AppConfig, logger?: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    application_name: config.serviceName,
    ssl: sslOption(config.databaseSsl),
    statement_timeout: 5_000,
  });
  pool.on('error', () => {
    logger?.error({ event: 'database_pool_error' }, 'database pool error');
  });
  return pool;
}

function sslOption(mode: AppConfig['databaseSsl']): pg.PoolConfig['ssl'] {
  if (mode === 'disable') return false;
  if (mode === 'verify') return { rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}
