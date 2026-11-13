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
import { PostgresRateLimiter } from '../../src/modules/auth/postgres-rate-limit.js';
import { MemoryRateLimiter } from '../../src/modules/auth/rate-limit.js';
import { registrationBody } from '../registration.js';
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
    const created = await call(jar, '/auth/register', { body: registrationBody(email, password) });
    expect(created.status).toBe(202);
    expect(await created.json()).toEqual({ status: 'accepted' });
    const duplicate = await call(new Map(), '/auth/register', {
      body: registrationBody(email, password),
    });
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toEqual({ status: 'accepted' });
    const users = await pool.query<{ email: string; status: string; role_code: string }>(
      `SELECT u.email, u.status, ur.role_code
       FROM users u JOIN user_roles ur ON ur.user_id = u.id WHERE u.email = $1`,
      [email],
    );
    expect(users.rows).toEqual([{ email, status: 'ACTIVE', role_code: 'TRADER' }]);
    const storedPhone = await pool.query<{ phone_e164: string; email_verified_at: Date | null }>(
      `SELECT phone_e164, email_verified_at FROM users WHERE email = $1`,
      [email],
    );
    expect(storedPhone.rows[0]).toMatchObject({
      phone_e164: '+14155552671',
      email_verified_at: null,
    });
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
      body: { ...registrationBody('not-an-email', password), email: 'not-an-email' },
    });
    expect(invalid.status).toBe(400);
    const missing = await call(jar, '/auth/register', { body: { email: uniqueEmail(), password } });
    expect(missing.status).toBe(400);
    const weak = await call(jar, '/auth/register', {
      body: registrationBody(uniqueEmail(), 'short'),
    });
    expect(weak.status).toBe(400);
    const escalation = await call(jar, '/auth/register', {
      body: { ...registrationBody(uniqueEmail(), password), role: 'ADMIN' },
    });
    expect(escalation.status).toBe(400);
    const admins = await pool.query("SELECT 1 FROM user_roles WHERE role_code = 'ADMIN'");
    expect(admins.rowCount).toBe(0);
  });

  it('verifies email once and rejects an expired token', async () => {
    const email = uniqueEmail();
    await call(new Map(), '/auth/register', { body: registrationBody(email) });
    const token = tokenFrom(sender.messages.at(-1)?.text ?? '');
    remember(token);
    const ok = await call(new Map(), '/auth/email/verify', { body: { token } });
    expect(ok.status).toBe(200);
    const again = await call(new Map(), '/auth/email/verify', { body: { token } });
    expect(again.status).toBe(400);
    const second = uniqueEmail();
    await call(new Map(), '/auth/register', { body: registrationBody(second) });
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
    const registered = registrationBody(email, password);
    await call(new Map(), '/auth/register', { body: registered });
    const jar = new Map<string, string>();
    const success = await call(jar, '/auth/login', { body: { email, password } });
    expect(success.status).toBe(200);
    expect(await success.json()).toMatchObject({ status: 'authenticated', mfaRequired: false });
    expect(jar.get('k2_session')).toBeTruthy();
    const me = await call(jar, '/users/me');
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      email,
      username: registered.username,
      phone: '+14155552671',
      emailVerified: false,
      status: 'ACTIVE',
    });
    expect((await call(jar, '/accounts')).status).toBe(403);
    expect(
      ((await (await call(jar, '/market-data/quotes/TEST')).json()) as { error: { code: string } })
        .error.code,
    ).toBe('EMAIL_NOT_VERIFIED');
    const byUsername = await call(new Map(), '/auth/login', {
      body: { username: registered.username, password },
    });
    expect(byUsername.status).toBe(200);

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
    await call(new Map(), '/auth/register', { body: registrationBody(email, password) });
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
    await call(new Map(), '/auth/register', { body: registrationBody(email, password) });
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
    await call(new Map(), '/auth/register', { body: registrationBody(fresh, password) });
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
      body: registrationBody(traderEmail, traderPassword),
    });
    const trader = new Map<string, string>();
    await call(trader, '/auth/login', { body: { email: traderEmail, password: traderPassword } });
    const traderId = profileId(await (await call(trader, '/users/me')).json());
    const other = new Map<string, string>();
    const otherEmail = uniqueEmail();
    await call(new Map(), '/auth/register', {
      body: registrationBody(otherEmail, traderPassword),
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
    const supportView = await call(support, `/staff/users/${traderId}`);
    expect(supportView.status).toBe(200);
    const supportBody = (await supportView.json()) as Record<string, unknown>;
    expect(supportBody).not.toHaveProperty('phone');
    expect(supportBody).not.toHaveProperty('streetAddress');
    expect((await call(support, `/staff/users/${traderId}/sensitive`)).status).toBe(403);
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
    const sensitive = await call(admin, `/staff/users/${traderId}/sensitive`);
    expect(sensitive.status).toBe(200);
    expect(await sensitive.json()).toMatchObject({
      phone: '+14155552671',
      streetAddress: '1 Market Street',
    });
    const sensitiveAudit = await pool.query(
      `SELECT 1 FROM authentication_audit_events WHERE event_type = 'staff.sensitive_profile_read' AND target_user_id = $1`,
      [traderId],
    );
    expect(sensitiveAudit.rowCount).toBe(1);
  });

  it('stores one username when two registrations race and shares rate limits', async () => {
    const username = `race${randomUUID().replace(/-/g, '')}`.slice(0, 32);
    const [left, right] = await Promise.all([
      call(new Map(), '/auth/register', {
        body: registrationBody(uniqueEmail(), 'correct-horse-battery', username),
      }),
      call(new Map(), '/auth/register', {
        body: registrationBody(uniqueEmail(), 'correct-horse-battery', username),
      }),
    ]);
    expect([left.status, right.status].sort()).toEqual([202, 409]);
    const rows = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM users WHERE username = $1`,
      [username],
    );
    expect(rows.rows[0]?.count).toBe(1);

    const sharedA = new PostgresRateLimiter(pool);
    const sharedB = new PostgresRateLimiter(pool);
    const raced = await Promise.all([
      sharedA.consume('correction-race', 1, 60_000),
      sharedB.consume('correction-race', 1, 60_000),
    ]);
    expect(raced.filter((decision) => decision.ok)).toHaveLength(1);
    expect(await sharedA.recordFailure('correction-fail', 60_000)).toBe(1);
    expect(await sharedB.failureCount('correction-fail', 60_000)).toBe(1);
    await sharedA.clearFailures('correction-fail');
    expect(await sharedB.failureCount('correction-fail', 60_000)).toBe(0);

    const identityColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'external_identities'`,
    );
    expect(identityColumns.rows.map((row) => row.column_name)).not.toContain('email');
    const links = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM external_identities`,
    );
    expect(links.rows[0]?.count).toBe(0);
    const readers = await pool.query<{ role_code: string }>(
      `SELECT role_code FROM role_permissions WHERE permission_code = 'staff.users.read' ORDER BY role_code`,
    );
    expect(readers.rows.map((row) => row.role_code)).toEqual(['ADMIN', 'SUPPORT']);
    const sensitiveReaders = await pool.query<{ role_code: string }>(
      `SELECT role_code FROM role_permissions WHERE permission_code = 'staff.users.sensitive.read' ORDER BY role_code`,
    );
    expect(sensitiveReaders.rows.map((row) => row.role_code)).toEqual(['ADMIN']);
  });

  it('rejects staff MFA reset for a trader and blocks removing the last administrator concurrently', async () => {
    const traderEmail = uniqueEmail();
    const traderPassword = 'correct-horse-battery';
    await call(new Map(), '/auth/register', {
      body: registrationBody(traderEmail, traderPassword),
    });
    const trader = new Map<string, string>();
    await call(trader, '/auth/login', { body: { email: traderEmail, password: traderPassword } });
    const enrolled = await call(trader, '/auth/mfa/enroll', { method: 'POST' });
    const traderSecret = ((await enrolled.json()) as { secret: string }).secret;
    remember(traderSecret);
    expect(
      (
        await call(trader, '/auth/mfa/verify', {
          method: 'POST',
          body: { code: totp(traderSecret) },
        })
      ).status,
    ).toBe(200);
    const traderId = profileId(await (await call(trader, '/users/me')).json());

    const adminEmail = uniqueEmail();
    const adminPassword = 'administrator-horse-battery';
    await pool.query(`DELETE FROM user_roles WHERE role_code = 'ADMIN'`);
    await createInitialAdmin(new IdentityRepository(pool), adminEmail, adminPassword, {
      ip: null,
      userAgent: 'test',
    });
    const admin = new Map<string, string>();
    await call(admin, '/auth/login', { body: { email: adminEmail, password: adminPassword } });
    const adminEnroll = await call(admin, '/auth/mfa/enroll', { method: 'POST' });
    const adminSecret = ((await adminEnroll.json()) as { secret: string }).secret;
    remember(adminSecret);
    await call(admin, '/auth/mfa/verify', { method: 'POST', body: { code: totp(adminSecret) } });
    const rejected = await call(admin, `/staff/users/${traderId}/mfa/reset`, {
      method: 'POST',
      body: { password: adminPassword, totp: totp(adminSecret) },
    });
    expect(rejected.status).toBe(403);
    const stillEnrolled = await pool.query(
      `SELECT 1 FROM mfa_factors WHERE user_id = $1 AND disabled_at IS NULL AND confirmed_at IS NOT NULL`,
      [traderId],
    );
    expect(stillEnrolled.rowCount).toBe(1);
    const rejection = await pool.query(
      `SELECT 1 FROM authentication_audit_events WHERE event_type = 'staff.mfa_reset_rejected' AND target_user_id = $1`,
      [traderId],
    );
    expect(rejection.rowCount).toBe(1);

    const secondEmail = uniqueEmail();
    const secondPassword = 'second-admin-horse-battery';
    expect(
      (
        await call(admin, '/staff/invitations', {
          method: 'POST',
          body: {
            email: secondEmail,
            role: 'ADMIN',
            password: adminPassword,
            totp: totp(adminSecret),
          },
        })
      ).status,
    ).toBe(202);
    const invite = tokenFrom(
      sender.messages.find((message) => message.to === secondEmail)?.text ?? '',
    );
    remember(invite);
    expect(
      (
        await call(new Map(), '/auth/invitations/accept', {
          method: 'POST',
          body: { token: invite, password: secondPassword },
        })
      ).status,
    ).toBe(201);
    const second = new Map<string, string>();
    await call(second, '/auth/login', { body: { email: secondEmail, password: secondPassword } });
    const secondEnroll = await call(second, '/auth/mfa/enroll', { method: 'POST' });
    const secondSecret = ((await secondEnroll.json()) as { secret: string }).secret;
    remember(secondSecret);
    await call(second, '/auth/mfa/verify', { method: 'POST', body: { code: totp(secondSecret) } });
    const adminId = profileId(await (await call(admin, '/users/me')).json());
    const secondId = profileId(await (await call(second, '/users/me')).json());
    const [removeSecond, removeFirst] = await Promise.all([
      call(admin, `/staff/users/${secondId}/roles`, {
        method: 'POST',
        body: { roles: ['TRADER'], password: adminPassword, totp: totp(adminSecret) },
      }),
      call(second, `/staff/users/${adminId}/roles`, {
        method: 'POST',
        body: { roles: ['TRADER'], password: secondPassword, totp: totp(secondSecret) },
      }),
    ]);
    const statuses = [removeSecond.status, removeFirst.status].sort();
    expect(statuses).toEqual([200, 409]);
    const admins = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM user_roles ur
       JOIN users u ON u.id = ur.user_id
       WHERE ur.role_code = 'ADMIN' AND u.status = 'ACTIVE'`,
    );
    expect(admins.rows[0]?.count).toBe(1);
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
