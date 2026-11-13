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
    expect(config.trustProxy).toEqual({ mode: 'off' });
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
        MFA_ENCRYPTION_KEY: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'),
        EMAIL_DELIVERY: 'unconfigured',
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

  it('accepts a hop count or a proxy range and rejects trust-all values', () => {
    expect(loadConfig(validEnv({ TRUST_PROXY: '1' })).trustProxy).toEqual({
      mode: 'hops',
      hops: 1,
    });
    expect(loadConfig(validEnv({ TRUST_PROXY: 'false' })).trustProxy).toEqual({ mode: 'off' });
    expect(loadConfig(validEnv({ TRUST_PROXY: '10.0.0.0/8, 192.0.2.10' })).trustProxy).toEqual({
      mode: 'ranges',
      ranges: ['10.0.0.0/8', '192.0.2.10'],
    });
    expect(loadConfig(validEnv({ TRUST_PROXY: 'fd00::/8' })).trustProxy).toEqual({
      mode: 'ranges',
      ranges: ['fd00::/8'],
    });

    for (const value of ['true', 'TRUE', '*', 'yes', '0.0.0.0/0', '::/0', '6', 'not-a-proxy']) {
      expect(() => loadConfig(validEnv({ TRUST_PROXY: value }))).toThrow(/TRUST_PROXY/);
    }
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
