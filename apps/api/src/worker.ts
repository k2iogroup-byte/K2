import { loadConfig } from './config/env.js';
import { loadEnvFile } from './config/load-env-file.js';
import { resolveEnvFile } from './config/paths.js';
import { createPool } from './infrastructure/db/pool.js';
import { PgDatabaseProbe } from './infrastructure/db/probe.js';
import { createLogger } from './infrastructure/logging/logger.js';
import { isDirectRun } from './runtime/is-direct-run.js';
import { reportFatal } from './runtime/report-fatal.js';

/** Module 01 registers no background jobs. Later modules append names here. */
export const REGISTERED_JOBS: readonly string[] = [];

export type WorkerRuntime = {
  close(): Promise<void>;
};

export async function startWorker(env: NodeJS.ProcessEnv): Promise<WorkerRuntime> {
  const config = loadConfig(env);
  const logger = createLogger(config);
  const pool = createPool(config, logger);
  try {
    const check = await new PgDatabaseProbe(pool, logger).check();
    if (!check.reachable || !check.migrated) {
      throw new Error('Worker requires a reachable, migrated database');
    }
    logger.info(
      { event: 'worker_started', jobs: REGISTERED_JOBS.length },
      'background worker idle; no jobs are registered in Module 01',
    );
    return {
      async close() {
        logger.info({ event: 'worker_stopped' }, 'background worker stopped');
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

if (isDirectRun(import.meta.url)) {
  const envFile = resolveEnvFile();
  if (envFile) loadEnvFile(envFile);
  startWorker(process.env)
    .then((runtime) => {
      // The pool drops idle connections, so a timer holds the process until a signal arrives.
      const timer = setInterval(() => undefined, 60_000);
      const shutdown = (): void => {
        clearInterval(timer);
        runtime
          .close()
          .then(() => {
            process.exit(0);
          })
          .catch(() => {
            process.exit(1);
          });
      };
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    })
    .catch((error: unknown) => {
      reportFatal(error);
      process.exit(1);
    });
}
