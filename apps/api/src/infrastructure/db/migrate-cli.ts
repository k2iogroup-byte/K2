import { ConfigError, loadConfig } from '../../config/env.js';
import { loadEnvFile } from '../../config/load-env-file.js';
import { migrationsDirectory, resolveEnvFile } from '../../config/paths.js';
import { isDirectRun } from '../../runtime/is-direct-run.js';
import { redactSensitiveText } from '../logging/redact.js';
import { migrateDown, migrateUp, migrationStatus } from './migrator.js';
import { createPool } from './pool.js';

async function main(): Promise<void> {
  const envFile = resolveEnvFile();
  if (envFile) loadEnvFile(envFile);
  const command = process.argv[2];
  if (command !== 'up' && command !== 'down' && command !== 'status') {
    process.stderr.write('Usage: migrate-cli <up|down|status>\n');
    process.exitCode = 1;
    return;
  }
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(
        `${JSON.stringify({ level: 'fatal', event: 'invalid_configuration', issues: error.issues })}\n`,
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  const pool = createPool(config);
  try {
    const directory = migrationsDirectory();
    if (command === 'up') {
      const applied = await migrateUp(pool, directory);
      process.stdout.write(
        applied.length === 0
          ? 'no pending migrations\n'
          : applied.map((version) => `applied ${version}\n`).join(''),
      );
      return;
    }
    if (command === 'down') {
      const version = await migrateDown(pool, directory);
      process.stdout.write(
        version === null ? 'nothing to roll back\n' : `rolled back ${version}\n`,
      );
      return;
    }
    const rows = await migrationStatus(pool, directory);
    if (rows.length === 0) {
      process.stdout.write('no migrations\n');
      return;
    }
    for (const row of rows) {
      process.stdout.write(`${row.version} ${row.name} ${row.state} ${row.appliedAt ?? '-'}\n`);
    }
  } finally {
    await pool.end();
  }
}

if (isDirectRun(import.meta.url)) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? redactSensitiveText(error.message) : 'migration failed';
    process.stderr.write(
      `${JSON.stringify({ level: 'fatal', event: 'migration_failed', message })}\n`,
    );
    process.exitCode = 1;
  });
}
