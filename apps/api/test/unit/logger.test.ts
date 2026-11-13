import { describe, expect, it } from 'vitest';

import { createLogger } from '../../src/infrastructure/logging/logger.js';

describe('structured logging', () => {
  it('redacts sensitive object fields and drops query strings', () => {
    const lines: string[] = [];
    const logger = createLogger(
      { logLevel: 'info', serviceName: 'k2-api' },
      { write: (chunk: string) => lines.push(chunk) },
    );
    logger.info(
      {
        databaseUrl: 'postgresql://k2:local-dev-password-value@127.0.0.1:5432/k2_dev',
        password: 'local-dev-password-value',
        req: {
          method: 'GET',
          url: '/health?token=local-dev-password-value',
          id: 'req-1',
          headers: { authorization: 'Bearer local-dev-password-value' },
        },
      },
      'request',
    );
    const output = lines.join('');
    expect(output).not.toContain('local-dev-password-value');
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('token=');
  });
});
