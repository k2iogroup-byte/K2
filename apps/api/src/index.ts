import { loadEnvFile } from './config/load-env-file.js';
import { resolveEnvFile } from './config/paths.js';
import { isDirectRun } from './runtime/is-direct-run.js';
import { reportFatal } from './runtime/report-fatal.js';
import { startServer } from './server.js';

if (isDirectRun(import.meta.url)) {
  const envFile = resolveEnvFile();
  if (envFile) loadEnvFile(envFile);
  startServer(process.env)
    .then((runtime) => {
      const shutdown = (signal: string): void => {
        runtime.app.log.info({ event: 'shutdown_requested', signal }, 'shutdown requested');
        runtime.app
          .close()
          .then(() => {
            process.exit(0);
          })
          .catch(() => {
            process.exit(1);
          });
      };
      process.once('SIGTERM', () => {
        shutdown('SIGTERM');
      });
      process.once('SIGINT', () => {
        shutdown('SIGINT');
      });
    })
    .catch((error: unknown) => {
      reportFatal(error);
      process.exit(1);
    });
}
