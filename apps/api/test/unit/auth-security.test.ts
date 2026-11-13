import { registerRequestSchema } from '@k2/shared';
import { Secret, TOTP } from 'otpauth';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/env.js';
import { redactSensitiveText } from '../../src/infrastructure/logging/redact.js';
import { decryptSecret, encryptSecret } from '../../src/modules/auth/mfa-crypto.js';
import { hashPassword, verifyPassword } from '../../src/modules/auth/passwords.js';
import { MemoryRateLimiter, progressiveDelayMs } from '../../src/modules/auth/rate-limit.js';
import { hashToken, newOpaqueToken, newRecoveryCodes } from '../../src/modules/auth/tokens.js';
import { createTotpSecret, totpUri, totpValid } from '../../src/modules/auth/totp.js';
import { validEnv } from '../valid-env.js';

describe('password and token storage', () => {
  it('hashes passwords with argon2id and does not keep the plaintext', async () => {
    const password = 'correct-horse-battery';
    const encoded = await hashPassword(password);
    expect(encoded.startsWith('$argon2id$')).toBe(true);
    expect(encoded).not.toContain(password);
    expect(await verifyPassword(encoded, password)).toBe(true);
    expect(await verifyPassword(encoded, 'wrong-horse-battery')).toBe(false);
  });

  it('stores only a hash of an opaque token', () => {
    const token = newOpaqueToken();
    const hashed = hashToken(token);
    expect(token).toHaveLength(43);
    expect(hashed).toHaveLength(64);
    expect(hashed).not.toContain(token);
  });

  it('rejects registration fields that could assign a role', () => {
    expect(
      registerRequestSchema.safeParse({
        email: 'trader@example.com',
        password: 'correct-horse-battery',
        role: 'ADMIN',
      }).success,
    ).toBe(false);
    expect(
      registerRequestSchema.safeParse({
        email: 'trader@example.com',
        password: 'short',
      }).success,
    ).toBe(false);
  });
});

describe('mfa secret protection', () => {
  it('encrypts the TOTP secret and accepts only the current code', () => {
    const key = Buffer.alloc(32, 7);
    const secret = createTotpSecret();
    const encrypted = encryptSecret(key, secret, 'user-1');
    expect(encrypted.ciphertext).not.toContain(secret);
    expect(decryptSecret(key, encrypted, 'user-1')).toBe(secret);
    expect(decryptSecret(key, encrypted, 'user-2')).toBeNull();
    expect(totpUri('trader@example.com', secret)).toContain(secret);
    expect(totpValid('trader@example.com', secret, '000000')).toBe(false);
    const code = new TOTP({
      secret: Secret.fromBase32(secret),
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    }).generate();
    expect(totpValid('trader@example.com', secret, code)).toBe(true);
  });

  it('creates recovery codes that are not equal to their hashes', () => {
    const codes = newRecoveryCodes(2);
    expect(codes).toHaveLength(2);
    expect(hashToken(codes[0] ?? '')).not.toBe(codes[0]);
  });
});

describe('login delay and rate limit', () => {
  it('increases delay with prior failures and then blocks', () => {
    expect(progressiveDelayMs(0, 250, 4_000)).toBe(0);
    expect(progressiveDelayMs(1, 250, 4_000)).toBe(250);
    expect(progressiveDelayMs(2, 250, 4_000)).toBe(500);
    expect(progressiveDelayMs(8, 250, 4_000)).toBe(4_000);
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now);
    expect(limiter.consume('register', 2, 1_000)).toEqual({ ok: true });
    expect(limiter.consume('register', 2, 1_000)).toEqual({ ok: true });
    expect(limiter.consume('register', 2, 1_000).ok).toBe(false);
    now = 1_000;
    expect(limiter.consume('register', 2, 1_000).ok).toBe(true);
  });
});

describe('auth configuration', () => {
  it('rejects the development MFA fixture and capture delivery outside development', () => {
    expect(() =>
      loadConfig(
        validEnv({
          APP_ENV: 'production',
          HOST: '0.0.0.0',
          CORS_ORIGINS: 'https://k2.example.com',
          DATABASE_SSL: 'verify',
          DATABASE_URL: 'postgresql://k2:local-dev-password-value@db.example.com:5432/k2',
          MFA_ENCRYPTION_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
          EMAIL_DELIVERY: 'capture',
        }),
      ),
    ).toThrow(/development fixture|capture is only allowed/);
  });

  it('redacts session cookies and tokens in free text', () => {
    const text = redactSensitiveText(
      'cookie k2_session=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 token=abc',
    );
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(text).toContain('[REDACTED]');
  });
});
