import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { Secret, TOTP } from 'otpauth';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { createInitialAdmin } from '../../src/cli/bootstrap-staff.js';
import { loadConfig } from '../../src/config/env.js';
import { apiPackageRoot } from '../../src/config/paths.js';
import { IdentityRepository } from '../../src/infrastructure/db/identity-repository.js';
import { migrateUp } from '../../src/infrastructure/db/migrator.js';
import { PgDatabaseProbe } from '../../src/infrastructure/db/probe.js';
import { createLogger, loggerOptions } from '../../src/infrastructure/logging/logger.js';
import { CaptureEmailSender } from '../../src/modules/auth/email.js';
import { MemoryRateLimiter } from '../../src/modules/auth/rate-limit.js';
import { validEnv } from '../valid-env.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a database whose name ends with _test');
if (!new URL(databaseUrl).pathname.replace(/^\//, '').endsWith('_test')) {
  throw new Error(
    'Refusing to run integration tests against a database whose name does not end with _test',
  );
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const sender = new CaptureEmailSender(null);
const limiter = new MemoryRateLimiter();
const lines: string[] = [];
const secrets = new Set<string>();

let baseUrl = '';
let appClose: (() => Promise<void>) | null = null;

type Jar = Map<string, string>;

beforeAll(async () => {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query('GRANT ALL ON SCHEMA public TO public');
  await migrateUp(pool, path.join(apiPackageRoot(), 'db', 'migrations'));
  const config = loadConfig(
    validEnv({
      DATABASE_URL: databaseUrl,
      PORT: '0',
      HOST: '127.0.0.1',
      AUTH_LOGIN_DELAY_BASE_MS: '0',
      AUTH_LOGIN_DELAY_CAP_MS: '0',
      EMAIL_DELIVERY: 'capture',
    }),
  );
  const stream = {
    write(chunk: string) {
      lines.push(chunk);
    },
  };
  const logger = createLogger(config, stream);
  const app = await buildApp({
    config,
    pool,
    emailSender: sender,
    limiter,
    database: new PgDatabaseProbe(pool, logger),
    logger: { ...loggerOptions(config), stream },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  appClose = async () => {
    await app.close();
  };
});

beforeEach(() => {
  limiter.clear();
  sender.messages.length = 0;
});

afterAll(async () => {
  if (appClose) await appClose();
  await pool.end();
  const log = lines.join('');
  for (const secret of secrets) {
    expect(log).not.toContain(secret);
  }
});

describe('module 02 authentication', () => {
  it('registers a trader, hides duplicates, and rejects escalation or weak passwords', async () => {
    const email = uniqueEmail();
    const password = remember('correct-horse-battery');
    const blocked = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(blocked.status).toBe(403);
    const jar = new Map<string, string>();
    const created = await call(jar, '/auth/register', { body: { email, password } });
    expect(created.status).toBe(202);
    expect(await created.json()).toEqual({ status: 'accepted' });
    const duplicate = await call(new Map(), '/auth/register', { body: { email, password } });
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toEqual({ status: 'accepted' });
    const users = await pool.query<{ email: string; status: string; role_code: string }>(
      `SELECT u.email, u.status, ur.role_code
       FROM users u JOIN user_roles ur ON ur.user_id = u.id WHERE u.email = $1`,
      [email],
    );
    expect(users.rows).toEqual([{ email, status: 'ACTIVE', role_code: 'TRADER' }]);
    const hash = await pool.query<{ password_hash: string }>(
      `SELECT c.password_hash FROM credentials c JOIN users u ON u.id = c.user_id WHERE u.email = $1`,
      [email],
    );
    expect(hash.rows[0]?.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(hash.rows[0]?.password_hash).not.toContain(password);
    expect(sender.messages.some((message) => message.purpose === 'email.verify')).toBe(true);
    expect(sender.messages.some((message) => message.purpose === 'email.already-registered')).toBe(
      true,
    );

    const invalid = await call(jar, '/auth/register', {
      body: { email: 'not-an-email', password },
    });
    expect(invalid.status).toBe(400);
    const weak = await call(jar, '/auth/register', {
      body: { email: uniqueEmail(), password: 'short' },
    });
    expect(weak.status).toBe(400);
    const escalation = await call(jar, '/auth/register', {
      body: { email: uniqueEmail(), password, role: 'ADMIN' },
    });
    expect(escalation.status).toBe(400);
    const admins = await pool.query("SELECT 1 FROM user_roles WHERE role_code = 'ADMIN'");
    expect(admins.rowCount).toBe(0);
  });

  it('verifies email once and rejects an expired token', async () => {
    const email = uniqueEmail();
    await call(new Map(), '/auth/register', { body: { email, password: 'correct-horse-battery' } });
    const token = tokenFrom(sender.messages.at(-1)?.text ?? '');
    remember(token);
    const ok = await call(new Map(), '/auth/email/verify', { body: { token } });
    expect(ok.status).toBe(200);
    const again = await call(new Map(), '/auth/email/verify', { body: { token } });
    expect(again.status).toBe(400);
    const second = uniqueEmail();
    await call(new Map(), '/auth/register', {
      body: { email: second, password: 'correct-horse-battery' },
    });
    const expired = tokenFrom(sender.messages.at(-1)?.text ?? '');
    remember(expired);
    await pool.query(
      `UPDATE email_verification_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`,
      [sha256(expired)],
    );
    expect((await call(new Map(), '/auth/email/verify', { body: { token: expired } })).status).toBe(
      400,
    );
  });

  it('logs in an unverified trader and rejects bad, suspended, and closed accounts', async () => {
    const email = uniqueEmail();
    const password = 'correct-horse-battery';
    await call(new Map(), '/auth/register', { body: { email, password } });
    const jar = new Map<string, string>();
    const success = await call(jar, '/auth/login', { body: { email, password } });
    expect(success.status).toBe(200);
    expect(await success.json()).toMatchObject({ status: 'authenticated', mfaRequired: false });
    expect(jar.get('k2_session')).toBeTruthy();
    const me = await call(jar, '/users/me');
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email, emailVerified: false, status: 'ACTIVE' });

    const wrong = await call(new Map(), '/auth/login', {
      body: { email, password: 'incorrect-horse-battery' },
    });
    const unknown = await call(new Map(), '/auth/login', {
      body: { email: uniqueEmail(), password },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toMatchObject({
      error: { message: 'Email or password is incorrect' },
    });
    expect(await unknown.json()).toMatchObject({
      error: { message: 'Email or password is incorrect' },
    });

    await pool.query(`UPDATE users SET status = 'SUSPENDED' WHERE email = $1`, [email]);
    const suspended = await call(new Map(), '/auth/login', { body: { email, password } });
    expect(suspended.status).toBe(403);
    expect(suspended.headers.get('set-cookie') ?? '').not.toContain('k2_session=');
    await pool.query(`UPDATE users SET status = 'CLOSED' WHERE email = $1`, [email]);
    expect((await call(new Map(), '/auth/login', { body: { email, password } })).status).toBe(403);
    await pool.query(`UPDATE users SET status = 'ACTIVE' WHERE email = $1`, [email]);
  });

  it('rate limits repeated login failures', async () => {
    const email = uniqueEmail();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect(
        (
          await call(new Map(), '/auth/login', {
            body: { email, password: 'incorrect-horse-battery' },
          })
        ).status,
      ).toBe(401);
    }
    const limited = await call(new Map(), '/auth/login', {
      body: { email, password: 'incorrect-horse-battery' },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });

  it('rotates sessions, expires them, and revokes one without revoking the other', async () => {
    const email = uniqueEmail();
    const password = 'correct-horse-battery';
    await call(new Map(), '/auth/register', { body: { email, password } });
    const first = new Map<string, string>();
    await call(first, '/auth/login', { body: { email, password } });
    const firstToken = first.get('k2_session') ?? '';
    await call(first, '/auth/login', { body: { email, password } });
    const rotated = new Map<string, string>([['k2_session', firstToken]]);
    expect((await call(rotated, '/auth/me')).status).toBe(401);
    expect((await call(first, '/auth/me')).status).toBe(200);

    const second = new Map<string, string>();
    await call(second, '/auth/login', { body: { email, password } });
    const secondId = sessionId(await (await call(second, '/auth/me')).json());
    expect((await call(first, `/auth/sessions/${secondId}`, { method: 'DELETE' })).status).toBe(
      200,
    );
    expect((await call(second, '/auth/me')).status).toBe(401);
    expect((await call(first, '/auth/me')).status).toBe(200);

    await pool.query(
      `UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id IN (SELECT id FROM users WHERE email = $1)`,
      [email],
    );
    expect((await call(first, '/auth/me')).status).toBe(401);
  });

  it('resets a password once, revokes sessions, and stays generic for unknown email', async () => {
    const email = uniqueEmail();
    const password = 'correct-horse-battery';
    await call(new Map(), '/auth/register', { body: { email, password } });
    const known = await call(new Map(), '/auth/password/forgot', { body: { email } });
    const unknown = await call(new Map(), '/auth/password/forgot', {
      body: { email: uniqueEmail() },
    });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(await known.json()).toEqual(await unknown.json());
    const token = tokenFrom(
      sender.messages.find((message) => message.purpose === 'password.reset')?.text ?? '',
    );
    remember(token);
    const jar = new Map<string, string>();
    await call(jar, '/auth/login', { body: { email, password } });
    const reset = await call(new Map(), '/auth/password/reset', {
      body: { token, password: 'replacement-horse-battery' },
    });
    expect(reset.status).toBe(200);
    expect((await call(jar, '/auth/me')).status).toBe(401);
    expect(
      (
        await call(new Map(), '/auth/password/reset', {
          body: { token, password: 'replacement-horse-battery-2' },
        })
      ).status,
    ).toBe(400);
    const fresh = uniqueEmail();
    await call(new Map(), '/auth/register', { body: { email: fresh, password } });
    await call(new Map(), '/auth/password/forgot', { body: { email: fresh } });
    const expired = tokenFrom(
      sender.messages.filter((message) => message.purpose === 'password.reset').at(-1)?.text ?? '',
    );
    await pool.query(
      `UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`,
      [sha256(expired)],
    );
    expect(
      (
        await call(new Map(), '/auth/password/reset', {
          body: { token: expired, password: 'replacement-horse-battery' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(new Map(), '/auth/login', {
          body: { email, password: 'replacement-horse-battery' },
        })
      ).status,
    ).toBe(200);
  });

  it('enforces RBAC, staff MFA, and one-time recovery codes', async () => {
    const traderEmail = uniqueEmail();
    const traderPassword = 'correct-horse-battery';
    await call(new Map(), '/auth/register', {
      body: { email: traderEmail, password: traderPassword },
    });
    const trader = new Map<string, string>();
    await call(trader, '/auth/login', { body: { email: traderEmail, password: traderPassword } });
    const traderId = profileId(await (await call(trader, '/users/me')).json());
    const other = new Map<string, string>();
    const otherEmail = uniqueEmail();
    await call(new Map(), '/auth/register', {
      body: { email: otherEmail, password: traderPassword },
    });
    await call(other, '/auth/login', { body: { email: otherEmail, password: traderPassword } });
    const otherId = profileId(await (await call(other, '/users/me')).json());
    expect((await call(trader, `/staff/users/${otherId}`)).status).toBe(403);
    const otherSession = sessionId(await (await call(other, '/auth/me')).json());
    expect(
      (await call(trader, `/auth/sessions/${otherSession}`, { method: 'DELETE' })).status,
    ).toBe(404);
    expect((await call(other, '/auth/me')).status).toBe(200);

    const adminEmail = uniqueEmail();
    const adminPassword = 'administrator-horse-battery';
    const adminId = await createInitialAdmin(
      new IdentityRepository(pool),
      adminEmail,
      adminPassword,
      {
        ip: null,
        userAgent: 'test',
      },
    );
    const admin = new Map<string, string>();
    await call(admin, '/auth/login', { body: { email: adminEmail, password: adminPassword } });
    expect((await call(admin, `/staff/users/${traderId}`)).status).toBe(403);
    const enrolled = await call(admin, '/auth/mfa/enroll', { method: 'POST' });
    expect(enrolled.status).toBe(200);
    const enrollment = (await enrolled.json()) as {
      secret: string;
      recoveryCodes: string[];
      otpauthUri: string;
    };
    remember(enrollment.secret);
    remember(enrollment.otpauthUri);
    for (const code of enrollment.recoveryCodes) remember(code);
    const stored = await pool.query<{ secret_ciphertext: string }>(
      'SELECT secret_ciphertext FROM mfa_factors WHERE user_id = $1',
      [adminId],
    );
    expect(stored.rows[0]?.secret_ciphertext).not.toContain(enrollment.secret);
    const confirm = await call(admin, '/auth/mfa/verify', {
      method: 'POST',
      body: { code: totp(enrollment.secret) },
    });
    expect(confirm.status).toBe(200);
    expect((await call(admin, `/staff/users/${traderId}`)).status).toBe(200);

    const challenged = new Map<string, string>();
    const challenge = await call(challenged, '/auth/login', {
      body: { email: adminEmail, password: adminPassword },
    });
    expect(await challenge.json()).toMatchObject({ mfaRequired: true });
    expect(challenged.has('k2_session')).toBe(false);
    expect((await call(challenged, `/staff/users/${traderId}`)).status).toBe(401);
    expect(
      (await call(challenged, '/auth/mfa/verify', { method: 'POST', body: { code: '000000' } }))
        .status,
    ).toBe(401);
    expect(
      (
        await call(challenged, '/auth/mfa/verify', {
          method: 'POST',
          body: { code: totp(enrollment.secret) },
        })
      ).status,
    ).toBe(200);
    expect((await call(challenged, `/staff/users/${traderId}`)).status).toBe(200);

    const recoveryJar = new Map<string, string>();
    await call(recoveryJar, '/auth/login', {
      body: { email: adminEmail, password: adminPassword },
    });
    const recovery = enrollment.recoveryCodes[0] ?? '';
    expect(
      (await call(recoveryJar, '/auth/mfa/recovery', { method: 'POST', body: { code: recovery } }))
        .status,
    ).toBe(200);
    const reuse = new Map<string, string>();
    await call(reuse, '/auth/login', { body: { email: adminEmail, password: adminPassword } });
    expect(
      (await call(reuse, '/auth/mfa/recovery', { method: 'POST', body: { code: recovery } }))
        .status,
    ).toBe(401);

    const supportEmail = uniqueEmail();
    const supportPassword = 'support-horse-battery';
    expect(
      (
        await call(admin, '/staff/invitations', {
          method: 'POST',
          body: {
            email: supportEmail,
            role: 'SUPPORT',
            password: adminPassword,
            totp: totp(enrollment.secret),
          },
        })
      ).status,
    ).toBe(202);
    const invite = tokenFrom(
      sender.messages.find((message) => message.purpose === 'staff.invite')?.text ?? '',
    );
    remember(invite);
    expect(
      (
        await call(new Map(), '/auth/invitations/accept', {
          method: 'POST',
          body: { token: invite, password: supportPassword },
        })
      ).status,
    ).toBe(201);
    const support = new Map<string, string>();
    await call(support, '/auth/login', {
      body: { email: supportEmail, password: supportPassword },
    });
    expect((await call(support, `/staff/users/${traderId}`)).status).toBe(403);
    const supportEnroll = await call(support, '/auth/mfa/enroll', { method: 'POST' });
    const supportSecret = ((await supportEnroll.json()) as { secret: string }).secret;
    remember(supportSecret);
    await call(support, '/auth/mfa/verify', {
      method: 'POST',
      body: { code: totp(supportSecret) },
    });
    expect((await call(support, `/staff/users/${traderId}`)).status).toBe(200);
    const supportId = profileId(await (await call(support, '/users/me')).json());
    const denied = await call(support, `/staff/users/${traderId}/roles`, {
      method: 'POST',
      body: { roles: ['ADMIN'], password: supportPassword, totp: totp(supportSecret) },
    });
    expect(denied.status).toBe(403);
    const changed = await call(admin, `/staff/users/${supportId}/roles`, {
      method: 'POST',
      body: { roles: ['RISK'], password: adminPassword, totp: totp(enrollment.secret) },
    });
    expect(changed.status).toBe(200);
    const audit = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM authentication_audit_events WHERE event_type = 'staff.roles_changed'`,
    );
    expect((audit.rowCount ?? 0) > 0).toBe(true);
  });
});

function uniqueEmail(): string {
  return `user-${randomUUID()}@example.com`;
}

function remember(value: string): string {
  secrets.add(value);
  return value;
}

function tokenFrom(text: string): string {
  const match = /#([A-Za-z0-9_-]{43})/.exec(text);
  if (!match?.[1]) throw new Error('Email did not contain a token');
  return match[1];
}

function totp(secret: string): string {
  return new TOTP({
    secret: Secret.fromBase32(secret),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  }).generate();
}

function sessionId(body: unknown): string {
  if (typeof body !== 'object' || body === null || !('session' in body)) {
    throw new Error('Missing session');
  }
  const session = body.session;
  if (
    typeof session !== 'object' ||
    session === null ||
    !('id' in session) ||
    typeof session.id !== 'string'
  ) {
    throw new Error('Missing session id');
  }
  return session.id;
}

function profileId(body: unknown): string {
  if (typeof body !== 'object' || body === null || !('id' in body) || typeof body.id !== 'string') {
    throw new Error('Missing profile id');
  }
  return body.id;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function call(
  jar: Jar,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<Response> {
  const method = init?.method ?? (init?.body === undefined ? 'GET' : 'POST');
  const headers = new Headers();
  if (method !== 'GET' && method !== 'HEAD') headers.set('x-k2-request', '1');
  if (init?.body !== undefined) headers.set('content-type', 'application/json');
  const csrf = jar.get('k2_csrf');
  if (csrf) headers.set('x-csrf-token', csrf);
  const cookie = [...jar.entries()]
    .filter(([name]) => name !== 'profile-id')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
  if (cookie) headers.set('cookie', cookie);
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body:
      method === 'GET' || method === 'HEAD' || init?.body === undefined
        ? undefined
        : JSON.stringify(init.body),
  });
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(';');
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const cleared = attrs.some((attr) => {
      const lower = attr.trim().toLowerCase();
      return lower.startsWith('max-age=0') || lower.includes('1970');
    });
    if (cleared) jar.delete(name);
    else jar.set(name, value);
  }
  return response;
}
