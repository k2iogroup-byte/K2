import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { emptyQuerySchema } from '@k2/shared';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { loadEnvFile } from '../../src/config/load-env-file.js';
import { AppError, installErrorHandling } from '../../src/infrastructure/http/errors.js';
import { isAllowedOrigin } from '../../src/infrastructure/http/origin.js';
import { resolveRequestId } from '../../src/infrastructure/http/request-id.js';
import { parseWithSchema } from '../../src/infrastructure/http/validation.js';
import { loggerOptions } from '../../src/infrastructure/logging/logger.js';
import { redactSensitiveText } from '../../src/infrastructure/logging/redact.js';

describe('centralized error handling', () => {
  it('hides unexpected error details and redacts secrets in the log', async () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: {
        ...loggerOptions({ logLevel: 'info', serviceName: 'k2-api' }),
        stream: {
          write(chunk: string) {
            lines.push(chunk);
          },
        },
      },
    });
    installErrorHandling(app);
    app.get('/boom', () => {
      throw new Error(
        'connect failed postgres://k2:local-dev-password-value@127.0.0.1:5432/k2_dev',
      );
    });
    const response = await app.inject({ method: 'GET', url: '/boom' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
    expect(response.body).not.toContain('local-dev-password-value');
    expect(lines.join('')).not.toContain('local-dev-password-value');
    expect(lines.join('')).toContain('[REDACTED]');
    await app.close();
  });

  it('returns a stable not-found body and validation details without the input value', async () => {
    const app = Fastify({ logger: false });
    installErrorHandling(app);
    app.get('/parse', (request) => {
      parseWithSchema(emptyQuerySchema, request.query);
      return { ok: true };
    });
    app.get('/known', () => {
      throw new AppError('VALIDATION_ERROR', 400, 'Request validation failed', [
        { path: 'query', message: 'Invalid value' },
      ]);
    });

    const missing = await app.inject({ method: 'GET', url: '/missing' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'NOT_FOUND', message: 'Not found' } });

    const invalid = await app.inject({ method: 'GET', url: '/parse?token=super-secret-value' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain('super-secret-value');
    expect(invalid.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const known = await app.inject({ method: 'GET', url: '/known' });
    expect(known.statusCode).toBe(400);
    expect(known.json()).toMatchObject({
      error: { details: [{ path: 'query', message: 'Invalid value' }] },
    });
    await app.close();
  });
});

describe('request guards', () => {
  it('rejects injected request ids and unknown origins', () => {
    expect(resolveRequestId('abc-123')).toBe('abc-123');
    expect(resolveRequestId('bad\nid')).not.toContain('\n');
    expect(resolveRequestId(['a', 'b'])).not.toBe('a');
    expect(isAllowedOrigin(undefined, ['http://127.0.0.1:3000'])).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:3000', ['http://127.0.0.1:3000'])).toBe(true);
    expect(isAllowedOrigin('https://evil.example', ['http://127.0.0.1:3000'])).toBe(false);
  });

  it('redacts connection strings and bearer tokens', () => {
    expect(
      redactSensitiveText('postgres://k2:local-dev-password-value@localhost/db Bearer abc.def'),
    ).toBe('[REDACTED] [REDACTED]');
  });

  it('does not override environment variables from a file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'k2-env-'));
    const file = path.join(dir, '.env');
    writeFileSync(file, 'UNIT_ENV_EXISTING=from-file\nUNIT_ENV_NEW=from-file\n# comment\n');
    process.env.UNIT_ENV_EXISTING = 'from-process';
    delete process.env.UNIT_ENV_NEW;
    loadEnvFile(file);
    expect(process.env.UNIT_ENV_EXISTING).toBe('from-process');
    expect(process.env.UNIT_ENV_NEW).toBe('from-file');
    delete process.env.UNIT_ENV_EXISTING;
    delete process.env.UNIT_ENV_NEW;
  });
});
