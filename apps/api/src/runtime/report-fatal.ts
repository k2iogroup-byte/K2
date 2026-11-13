import { ConfigError } from '../config/env.js';
import { redactSensitiveText } from '../infrastructure/logging/redact.js';

export function reportFatal(error: unknown): void {
  if (error instanceof ConfigError) {
    process.stderr.write(
      `${JSON.stringify({ level: 'fatal', event: 'invalid_configuration', issues: error.issues })}\n`,
    );
    return;
  }
  const message = error instanceof Error ? redactSensitiveText(error.message) : 'startup failed';
  process.stderr.write(`${JSON.stringify({ level: 'fatal', event: 'startup_failed', message })}\n`);
}
