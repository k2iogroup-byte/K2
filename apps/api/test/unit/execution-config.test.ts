import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/env.js';
import {
  FailClosedRiskAuthorizer,
  type RiskAuthorizer,
} from '../../src/modules/trading/risk-authorizer.js';
import { validEnv } from '../valid-env.js';

describe('execution stays fail closed', () => {
  it('rejects production fills and an unapproved authorizer', async () => {
    expect(loadConfig(validEnv()).executionFillsEnabled).toBe(false);
    expect(loadConfig(validEnv({ EXECUTION_ENABLED: 'true' })).executionFillsEnabled).toBe(true);
    expect(() =>
      loadConfig(
        validEnv({
          APP_ENV: 'production',
          HOST: '0.0.0.0',
          CORS_ORIGINS: 'https://k2.example.com',
          DATABASE_SSL: 'verify',
          DATABASE_URL: 'postgresql://k2:local-dev-password-value@db.example.com:5432/k2',
          MFA_ENCRYPTION_KEY: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'),
          EMAIL_DELIVERY: 'unconfigured',
          EXECUTION_ENABLED: 'true',
        }),
      ),
    ).toThrow(/fills stay off/);
    const authorizer: RiskAuthorizer = new FailClosedRiskAuthorizer();
    const decision = await authorizer.authorize({
      accountId: '00000000-0000-4000-8000-000000000001',
      instrumentId: '00000000-0000-4000-8000-000000000002',
      side: 'BUY',
      quantity: '1',
    });
    expect(decision).toMatchObject({ decision: 'REJECT', reasonCode: 'TEMPORARILY_UNAVAILABLE' });
  });
});
