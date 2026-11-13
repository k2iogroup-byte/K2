import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../../src/config/env.js';
import { validEnv } from '../valid-env.js';

const secret = 'super-secret-db-password';

describe('configuration validation', () => {
  it('accepts a development configuration', () => {
    const config = loadConfig(validEnv());
    expect(config.appEnv).toBe('development');
    expect(config.port).toBe(4000);
    expect(config.corsOrigins).toEqual(['http://127.0.0.1:3000']);
  });

  it('reports every missing required value without echoing a secret', () => {
    const databaseUrl = `postgresql://k2:${secret}@127.0.0.1:5432/k2_dev`;
    expect(() =>
      loadConfig(
        validEnv({
          APP_ENV: undefined,
          DATABASE_URL: 'not a url',
          DATABASE_SSL: undefined,
          CORS_ORIGINS: undefined,
        }),
      ),
    ).toThrow(ConfigError);

    try {
      loadConfig(
        validEnv({
          APP_ENV: 'nope',
          DATABASE_URL: databaseUrl.replace('k2_dev', ''),
          CORS_ORIGINS: '*',
        }),
      );
      throw new Error('expected config to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = error instanceof Error ? error.message : '';
      expect(message).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  it('rejects the example placeholder password', () => {
    expect(() =>
      loadConfig(
        validEnv({
          DATABASE_URL: 'postgresql://k2:REPLACE_WITH_LOCAL_PASSWORD@127.0.0.1:5432/k2_dev',
        }),
      ),
    ).toThrow(/password does not meet the baseline/);
  });

  it('requires https origins and a non-local database outside development', () => {
    expect(() =>
      loadConfig(
        validEnv({
          APP_ENV: 'production',
          CORS_ORIGINS: 'http://127.0.0.1:3000',
          DATABASE_SSL: 'verify',
          DATABASE_URL: 'postgresql://k2:local-dev-password-value@db.example.com:5432/k2',
        }),
      ),
    ).toThrow(/must use https/);

    const staging = loadConfig(
      validEnv({
        APP_ENV: 'staging',
        HOST: '0.0.0.0',
        CORS_ORIGINS: 'https://k2-staging.example.com',
        DATABASE_SSL: 'disable',
        DATABASE_URL:
          'postgresql://k2:local-dev-password-value@postgres.railway.internal:5432/railway',
      }),
    );
    expect(staging.databaseSsl).toBe('disable');

    expect(() =>
      loadConfig(
        validEnv({
          APP_ENV: 'production',
          CORS_ORIGINS: 'https://k2.example.com',
          DATABASE_SSL: 'disable',
          DATABASE_URL: 'postgresql://k2:local-dev-password-value@db.example.com:5432/k2',
        }),
      ),
    ).toThrow(/public database hosts/);
  });

  it('allows an ephemeral port only in development', () => {
    expect(loadConfig(validEnv({ PORT: '0' })).port).toBe(0);
    expect(() =>
      loadConfig(
        validEnv({
          APP_ENV: 'staging',
          PORT: '0',
          HOST: '0.0.0.0',
          CORS_ORIGINS: 'https://k2.example.com',
          DATABASE_SSL: 'verify',
          DATABASE_URL: 'postgresql://k2:local-dev-password-value@db.example.com:5432/k2',
        }),
      ),
    ).toThrow(/non-zero port/);
  });
});

describe('environment template', () => {
  it('keeps the example password as a placeholder', () => {
    const example = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.env.example'),
      'utf8',
    );
    expect(example).toContain('REPLACE_WITH_LOCAL_PASSWORD');
    expect(example).not.toMatch(/postgresql:\/\/[^:]+:(?!REPLACE_WITH_LOCAL_PASSWORD)[^@]+@/);
  });
});
