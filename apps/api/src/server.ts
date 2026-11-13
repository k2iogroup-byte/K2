import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { Logger } from 'pino';

import { buildApp } from './app.js';
import { type AppConfig, loadConfig } from './config/env.js';
import { createPool } from './infrastructure/db/pool.js';
import { PgDatabaseProbe } from './infrastructure/db/probe.js';
import { createLogger, loggerOptions } from './infrastructure/logging/logger.js';

export type ServerRuntime = {
  app: FastifyInstance;
  config: AppConfig;
};

export async function startServer(
  env: NodeJS.ProcessEnv,
  options?: { logStream?: { write(message: string): void } },
): Promise<ServerRuntime> {
  const config = loadConfig(env);
  const logger: Logger = options?.logStream
    ? createLogger(config, options.logStream)
    : createLogger(config);
  const fastifyLogger: FastifyServerOptions['logger'] = options?.logStream
    ? { ...loggerOptions(config), stream: options.logStream }
    : loggerOptions(config);
  const pool = createPool(config, logger);
  let poolClosed = false;
  const closePool = async (): Promise<void> => {
    if (poolClosed) return;
    poolClosed = true;
    await pool.end();
  };
  try {
    const app = await buildApp({
      config,
      logger: fastifyLogger,
      database: new PgDatabaseProbe(pool, logger),
      pool,
    });
    app.addHook('onClose', closePool);
    try {
      await app.listen({ host: config.host, port: config.port });
    } catch (error) {
      await app.close().catch(() => undefined);
      await closePool();
      throw error;
    }
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : config.port;
    logger.info(
      { event: 'server_started', host: config.host, port, appEnv: config.appEnv },
      'server started',
    );
    return { app, config };
  } catch (error) {
    await closePool();
    throw error;
  }
}
