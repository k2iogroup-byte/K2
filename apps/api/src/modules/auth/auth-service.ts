import { randomBytes } from 'node:crypto';

import type { AccountStatus, ProfileResponse, RoleCode, StaffRoleCode } from '@k2/shared';

import type { AppConfig } from '../../config/env.js';
import type {
  AuditEvent,
  IdentityRepository,
  ProfileRecord,
  SessionContext,
} from '../../infrastructure/db/identity-repository.js';
import { UniqueViolation } from '../../infrastructure/db/identity-repository.js';
import { AppError, RateLimitError } from '../../infrastructure/http/errors.js';
import {
  expiresAt,
  INVITATION_TTL_MS,
  LOGIN_FAILURE_LIMIT,
  LOGIN_FAILURE_WINDOW_MS,
  MFA_CHALLENGE_IDLE_SECONDS,
  MFA_CHALLENGE_MS,
  RESET_TTL_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_SECONDS,
  VERIFICATION_TTL_MS,
} from './durations.js';
import type { EmailMessage, EmailSender } from './email.js';
import { decryptSecret, encryptSecret } from './mfa-crypto.js';
import { ARGON2_PARAMETERS, hashPassword, verifyPassword } from './passwords.js';
import type { MemoryRateLimiter } from './rate-limit.js';
import { progressiveDelayMs } from './rate-limit.js';
import type { AuthContext } from './rbac.js';
import {
  hashToken,
  newOpaqueToken,
  newRecoveryCodes,
  normalizeRecoveryCode,
  tokensMatch,
} from './tokens.js';
import { createTotpSecret, totpUri, totpValid } from './totp.js';

const HOUR_MS = 60 * 60 * 1000;
const MFA_WINDOW_MS = 5 * 60 * 1000;
const MFA_ATTEMPT_LIMIT = 5;

export type RequestMeta = {
  ip: string | null;
  userAgent: string | null;
};

export type IssuedSession = {
  token: string;
  csrf: string;
  sessionId: string;
  expiresAt: Date;
};

type SafeLogger = {
  error(object: Record<string, string>, message: string): void;
};

export class AuthService {
  private dummyHashPromise: Promise<string> | null = null;

  constructor(
    private readonly repository: IdentityRepository,
    private readonly email: EmailSender,
    private readonly limiter: MemoryRateLimiter,
    private readonly config: Pick<
      AppConfig,
      'mfaEncryptionKey' | 'webOrigin' | 'loginDelayBaseMs' | 'loginDelayCapMs'
    >,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly logger?: SafeLogger,
  ) {
    this.dummyHashPromise = hashPassword(randomBytes(32).toString('base64url'));
  }

  async register(email: string, password: string, meta: RequestMeta): Promise<void> {
    this.requireDelivery();
    this.consume(`register:${meta.ip ?? 'unknown'}`, 5, HOUR_MS);
    const passwordHash = await hashPassword(password);
    const token = newOpaqueToken();
    let created = false;
    try {
      await this.repository.transaction(async (client) => {
        const userId = await this.repository.insertUser(client, {
          email,
          passwordHash,
          parameters: ARGON2_PARAMETERS,
          role: 'TRADER',
          grantedBy: null,
          emailVerified: false,
        });
        await this.repository.insertToken(
          client,
          'email_verification_tokens',
          userId,
          hashToken(token),
          expiresAt(VERIFICATION_TTL_MS),
        );
        await this.repository.insertAudit(
          {
            eventType: 'user.registered',
            actorUserId: userId,
            targetUserId: userId,
            ip: meta.ip,
            userAgent: clipAgent(meta.userAgent),
            metadata: { role: 'TRADER' },
          },
          client,
        );
      });
      created = true;
    } catch (error) {
      if (!(error instanceof UniqueViolation)) throw error;
    }
    const delivery = await this.deliver(
      created
        ? {
            to: email,
            subject: 'Verify your K2 Group email',
            purpose: 'email.verify',
            text: `Verify your email address.\n\n${this.link('/verify-email', token)}\n\nThis link expires in 24 hours and can be used once.\n`,
          }
        : {
            to: email,
            subject: 'K2 Group account',
            purpose: 'email.already-registered',
            text: 'An account already exists for this email address. Sign in or reset the password.\n',
          },
    );
    if (delivery === 'failed') {
      throw new AppError('EMAIL_DELIVERY_UNAVAILABLE', 503, 'Email delivery failed');
    }
  }

  async verifyEmail(token: string, meta: RequestMeta): Promise<void> {
    this.consume(`verify:${meta.ip ?? 'unknown'}`, 10, HOUR_MS);
    const userId = await this.repository.transaction(async (client) => {
      const id = await this.repository.consumeToken(
        client,
        'email_verification_tokens',
        hashToken(token),
      );
      if (!id) return null;
      await this.repository.markEmailVerified(client, id);
      await this.repository.invalidateTokens(client, 'email_verification_tokens', id);
      await this.repository.insertAudit(
        {
          eventType: 'email.verified',
          actorUserId: id,
          targetUserId: id,
          ip: meta.ip,
          userAgent: clipAgent(meta.userAgent),
          metadata: {},
        },
        client,
      );
      return id;
    });
    if (!userId) {
      throw new AppError('VALIDATION_ERROR', 400, 'This verification link is invalid or expired.');
    }
  }

  async resendVerification(email: string, meta: RequestMeta): Promise<void> {
    this.requireDelivery();
    this.consume(`resend-ip:${meta.ip ?? 'unknown'}`, 10, HOUR_MS);
    this.consume(`resend:${hashToken(email)}`, 3, HOUR_MS);
    const user = await this.repository.findUserByEmail(email);
    if (!user || user.emailVerifiedAt !== null || user.status === 'CLOSED') return;
    const token = newOpaqueToken();
    await this.repository.transaction(async (client) => {
      await this.repository.invalidateTokens(client, 'email_verification_tokens', user.id);
      await this.repository.insertToken(
        client,
        'email_verification_tokens',
        user.id,
        hashToken(token),
        expiresAt(VERIFICATION_TTL_MS),
      );
    });
    const delivery = await this.deliver({
      to: email,
      subject: 'Verify your K2 Group email',
      purpose: 'email.resend',
      text: `Verify your email address.\n\n${this.link('/verify-email', token)}\n\nThis link expires in 24 hours and can be used once.\n`,
    });
    if (delivery === 'failed') {
      throw new AppError('EMAIL_DELIVERY_UNAVAILABLE', 503, 'Email delivery failed');
    }
  }

  async login(
    email: string,
    password: string,
    meta: RequestMeta,
    presentedSessionToken: string | null,
  ): Promise<{ kind: 'full' | 'mfa'; session: IssuedSession }> {
    this.consume(`login-ip:${meta.ip ?? 'unknown'}`, 30, LOGIN_FAILURE_WINDOW_MS);
    const failureKey = `login:${hashToken(email)}`;
    const prior = this.limiter.failureCount(failureKey, LOGIN_FAILURE_WINDOW_MS);
    if (prior >= LOGIN_FAILURE_LIMIT) throw failureLimit(failureKey, this.limiter);
    await this.sleep(
      progressiveDelayMs(prior, this.config.loginDelayBaseMs, this.config.loginDelayCapMs),
    );
    const user = await this.repository.findUserByEmail(email);
    const passwordOk = await verifyPassword(
      user?.passwordHash ?? (await this.dummyHash()),
      password,
    );
    if (!user || !passwordOk) {
      this.limiter.recordFailure(failureKey, LOGIN_FAILURE_WINDOW_MS);
      await this.repository.insertAudit({
        eventType: 'login.failed',
        actorUserId: null,
        targetUserId: user?.id ?? null,
        ip: meta.ip,
        userAgent: clipAgent(meta.userAgent),
        metadata: { reason: 'invalid_credentials' },
      });
      throw new AppError('AUTHENTICATION_FAILED', 401, 'Email or password is incorrect');
    }
    if (user.status !== 'ACTIVE') {
      this.limiter.recordFailure(failureKey, LOGIN_FAILURE_WINDOW_MS);
      await this.repository.insertAudit({
        eventType: 'login.denied',
        actorUserId: user.id,
        targetUserId: user.id,
        ip: meta.ip,
        userAgent: clipAgent(meta.userAgent),
        metadata: { status: user.status },
      });
      throw new AppError('ACCOUNT_UNAVAILABLE', 403, 'This account cannot sign in');
    }
    this.limiter.clearFailures(failureKey);
    if (presentedSessionToken) await this.repository.revokeByHash(hashToken(presentedSessionToken));
    const mfa = await this.repository.hasConfirmedFactor(user.id);
    const session = await this.repository.transaction(async (client) =>
      this.issue(client, {
        userId: user.id,
        kind: mfa ? 'mfa_pending' : 'full',
        ttlMs: mfa ? MFA_CHALLENGE_MS : SESSION_ABSOLUTE_MS,
        meta,
        rotatedFromId: null,
        mfaVerifiedAt: null,
      }),
    );
    if (!mfa) {
      await this.repository.insertAudit({
        eventType: 'login.succeeded',
        actorUserId: user.id,
        targetUserId: user.id,
        ip: meta.ip,
        userAgent: clipAgent(meta.userAgent),
        metadata: {},
      });
    }
    return { kind: mfa ? 'mfa' : 'full', session };
  }

  async logout(auth: AuthContext | null): Promise<void> {
    if (!auth) return;
    await this.repository.revokeSession(auth.userId, auth.sessionId);
  }

  async loadSession(token: string | null): Promise<AuthContext | null> {
    if (!token) return null;
    const tokenHash = hashToken(token);
    await this.repository.expireIfDue(tokenHash, 'full', SESSION_IDLE_SECONDS);
    const row = await this.repository.findFullSession(tokenHash, SESSION_IDLE_SECONDS);
    if (!row) return null;
    if (row.status !== 'ACTIVE') {
      await this.repository.revokeAll(row.userId);
      return null;
    }
    await this.repository.touchSession(row.sessionId);
    return toContext(row);
  }

  async completeMfa(
    pendingToken: string | null,
    csrf: string | null,
    code: string,
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    const pending = await this.readPending(pendingToken, csrf);
    if (!pending) {
      throw new AppError('AUTHENTICATION_FAILED', 401, 'This sign-in attempt has expired');
    }
    await this.assertConfirmedTotp(pending.userId, pending.email, code);
    return this.repository.transaction(async (client) => {
      await this.repository.revokeExact(client, pending.userId, pending.sessionId);
      const session = await this.issue(client, {
        userId: pending.userId,
        kind: 'full',
        ttlMs: SESSION_ABSOLUTE_MS,
        meta,
        rotatedFromId: pending.sessionId,
        mfaVerifiedAt: new Date(),
      });
      await this.repository.insertAudit(
        {
          eventType: 'login.mfa',
          actorUserId: pending.userId,
          targetUserId: pending.userId,
          ip: meta.ip,
          userAgent: clipAgent(meta.userAgent),
          metadata: {},
        },
        client,
      );
      return session;
    });
  }

  async recoverMfa(
    pendingToken: string | null,
    csrf: string | null,
    code: string,
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    const pending = await this.readPending(pendingToken, csrf);
    if (!pending) {
      throw new AppError('AUTHENTICATION_FAILED', 401, 'This sign-in attempt has expired');
    }
    this.guardMfa(pending.userId);
    const normalized = normalizeRecoveryCode(code);
    const consumed = await this.repository.transaction(async (client) => {
      const ok = await this.repository.consumeRecoveryCode(
        client,
        pending.userId,
        hashToken(normalized),
      );
      if (!ok) return null;
      await this.repository.revokeExact(client, pending.userId, pending.sessionId);
      const session = await this.issue(client, {
        userId: pending.userId,
        kind: 'full',
        ttlMs: SESSION_ABSOLUTE_MS,
        meta,
        rotatedFromId: pending.sessionId,
        mfaVerifiedAt: new Date(),
      });
      await this.repository.insertAudit(
        {
          eventType: 'mfa.recovery_used',
          actorUserId: pending.userId,
          targetUserId: pending.userId,
          ip: meta.ip,
          userAgent: clipAgent(meta.userAgent),
          metadata: {},
        },
        client,
      );
      return session;
    });
    if (!consumed) {
      this.limiter.recordFailure(mfaKey(pending.userId), MFA_WINDOW_MS);
      throw new AppError('AUTHENTICATION_FAILED', 401, 'The recovery code is invalid');
    }
    return consumed;
  }

  async enrollMfa(
    auth: AuthContext,
  ): Promise<{ factorId: string; otpauthUri: string; secret: string; recoveryCodes: string[] }> {
    if (await this.repository.hasConfirmedFactor(auth.userId)) {
      throw new AppError('CONFLICT', 409, 'Multi-factor authentication is already enabled');
    }
    const secret = createTotpSecret();
    const encrypted = encryptSecret(this.config.mfaEncryptionKey, secret, auth.userId);
    const recoveryCodes = newRecoveryCodes();
    const factorId = await this.repository.transaction(async (client) => {
      await this.repository.clearUnconfirmedFactor(client, auth.userId);
      const id = await this.repository.insertFactor(
        client,
        auth.userId,
        encrypted.ciphertext,
        encrypted.nonce,
      );
      await this.repository.insertRecoveryCodes(
        client,
        auth.userId,
        id,
        recoveryCodes.map((code) => hashToken(normalizeRecoveryCode(code))),
      );
      return id;
    });
    return { factorId, otpauthUri: totpUri(auth.email, secret), secret, recoveryCodes };
  }

  async confirmEnrollment(
    auth: AuthContext,
    code: string,
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    this.guardMfa(auth.userId);
    const factor = await this.repository.findPendingFactor(auth.userId);
    const secret = factor
      ? decryptSecret(
          this.config.mfaEncryptionKey,
          { ciphertext: factor.ciphertext, nonce: factor.nonce },
          auth.userId,
        )
      : null;
    if (!factor || !secret || !totpValid(auth.email, secret, code)) {
      this.limiter.recordFailure(mfaKey(auth.userId), MFA_WINDOW_MS);
      throw new AppError('AUTHENTICATION_FAILED', 401, 'The authentication code is incorrect');
    }
    return this.repository.transaction(async (client) => {
      const confirmed = await this.repository.confirmFactor(client, auth.userId, factor.id);
      if (!confirmed) {
        throw new AppError('AUTHENTICATION_FAILED', 401, 'The authentication code is incorrect');
      }
      await this.repository.revokeAll(auth.userId, client);
      const session = await this.issue(client, {
        userId: auth.userId,
        kind: 'full',
        ttlMs: SESSION_ABSOLUTE_MS,
        meta,
        rotatedFromId: auth.sessionId,
        mfaVerifiedAt: new Date(),
      });
      await this.repository.insertAudit(
        {
          eventType: 'mfa.enrolled',
          actorUserId: auth.userId,
          targetUserId: auth.userId,
          ip: meta.ip,
          userAgent: clipAgent(meta.userAgent),
          metadata: { factor: 'totp' },
        },
        client,
      );
      return session;
    });
  }

  async disableMfa(
    auth: AuthContext,
    password: string,
    totp: string,
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    if (auth.staff) {
      throw new AppError('FORBIDDEN', 403, 'Staff multi-factor authentication cannot be disabled');
    }
    await this.reauthenticate(auth, password, totp);
    return this.repository.transaction(async (client) => {
      await this.repository.disableFactors(client, auth.userId);
      await this.repository.revokeAll(auth.userId, client);
      const session = await this.issue(client, {
        userId: auth.userId,
        kind: 'full',
        ttlMs: SESSION_ABSOLUTE_MS,
        meta,
        rotatedFromId: null,
        mfaVerifiedAt: null,
      });
      await this.repository.insertAudit(
        {
          eventType: 'mfa.disabled',
          actorUserId: auth.userId,
          targetUserId: auth.userId,
          ip: meta.ip,
          userAgent: clipAgent(meta.userAgent),
          metadata: {},
        },
        client,
      );
      return session;
    });
  }

  async forgotPassword(email: string, meta: RequestMeta): Promise<void> {
    this.requireDelivery();
    this.consume(`forgot-ip:${meta.ip ?? 'unknown'}`, 5, HOUR_MS);
    this.consume(`forgot:${hashToken(email)}`, 3, HOUR_MS);
    const user = await this.repository.findUserByEmail(email);
    if (!user || user.status === 'CLOSED') return;
    const token = newOpaqueToken();
    await this.repository.transaction(async (client) => {
      await this.repository.invalidateTokens(client, 'password_reset_tokens', user.id);
      await this.repository.insertToken(
        client,
        'password_reset_tokens',
        user.id,
        hashToken(token),
        expiresAt(RESET_TTL_MS),
      );
    });
    const delivery = await this.deliver({
      to: email,
      subject: 'Reset your K2 Group password',
      purpose: 'password.reset',
      text: `Reset your password.\n\n${this.link('/reset-password', token)}\n\nThis link expires in 1 hour and can be used once.\n`,
    });
    if (delivery === 'failed') {
      throw new AppError('EMAIL_DELIVERY_UNAVAILABLE', 503, 'Email delivery failed');
    }
  }

  async resetPassword(
    token: string,
    password: string,
    meta: RequestMeta,
  ): Promise<'sent' | 'unavailable'> {
    this.consume(`reset:${meta.ip ?? 'unknown'}`, 10, HOUR_MS);
    const passwordHash = await hashPassword(password);
    const userId = await this.repository.transaction(async (client) => {
      const id = await this.repository.consumeToken(
        client,
        'password_reset_tokens',
        hashToken(token),
      );
      if (!id) return null;
      await this.repository.updatePassword(client, id, passwordHash);
      await this.repository.invalidateTokens(client, 'password_reset_tokens', id);
      await this.repository.revokeAll(id, client);
      await this.repository.insertAudit(
        {
          eventType: 'password.reset',
          actorUserId: id,
          targetUserId: id,
          ip: meta.ip,
          userAgent: clipAgent(meta.userAgent),
          metadata: {},
        },
        client,
      );
      return id;
    });
    if (!userId) {
      throw new AppError('VALIDATION_ERROR', 400, 'This reset link is invalid or expired.');
    }
    return this.notify(userId, {
      subject: 'Your K2 Group password was reset',
      purpose: 'password.reset-notice',
      text: 'Your password was reset and existing sessions were signed out. If you did not do this, contact support.\n',
    });
  }

  async changePassword(
    auth: AuthContext,
    currentPassword: string,
    newPassword: string,
    totp: string | undefined,
    meta: RequestMeta,
  ): Promise<{ session: IssuedSession; notification: 'sent' | 'unavailable' }> {
    const user = await this.repository.findUserByEmail(auth.email);
    if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) {
      throw new AppError('AUTHENTICATION_FAILED', 401, 'Email or password is incorrect');
    }
    if (auth.mfaEnrolled) {
      if (!totp) {
        throw new AppError('AUTHENTICATION_FAILED', 401, 'The authentication code is incorrect');
      }
      await this.assertConfirmedTotp(auth.userId, auth.email, totp);
    }
    const passwordHash = await hashPassword(newPassword);
    const session = await this.repository.transaction(async (client) => {
      await this.repository.updatePassword(client, auth.userId, passwordHash);
      await this.repository.revokeAll(auth.userId, client);
      const issued = await this.issue(client, {
        userId: auth.userId,
        kind: 'full',
        ttlMs: SESSION_ABSOLUTE_MS,
        meta,
        rotatedFromId: auth.sessionId,
        mfaVerifiedAt: auth.mfaSatisfied ? new Date() : null,
      });
      await this.repository.insertAudit(
        {
          eventType: 'password.changed',
          actorUserId: auth.userId,
          targetUserId: auth.userId,
          ip: meta.ip,
          userAgent: clipAgent(meta.userAgent),
          metadata: {},
        },
        client,
      );
      return issued;
    });
    const notification = await this.notify(auth.userId, {
      subject: 'Your K2 Group password was changed',
      purpose: 'password.changed',
      text: 'Your password was changed and other sessions were signed out.\n',
    });
    return { session, notification };
  }

  async listSessions(auth: AuthContext): Promise<
    {
      id: string;
      createdAt: string;
      lastSeenAt: string;
      expiresAt: string;
      ip: string | null;
      userAgent: string | null;
      current: boolean;
    }[]
  > {
    const rows = await this.repository.listSessions(auth.userId);
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      ip: row.ip,
      userAgent: row.userAgent,
      current: row.id === auth.sessionId,
    }));
  }

  async revokeOne(auth: AuthContext, sessionId: string): Promise<number> {
    const revoked = await this.repository.revokeSession(auth.userId, sessionId);
    if (!revoked) throw new AppError('NOT_FOUND', 404, 'Not found');
    return 1;
  }

  async revokeOthers(auth: AuthContext): Promise<number> {
    return this.repository.revokeOthers(auth.userId, auth.sessionId);
  }

  async updateProfile(auth: AuthContext, displayName: string | null): Promise<ProfileResponse> {
    const updated = await this.repository.updateDisplayName(auth.userId, displayName);
    if (!updated) throw new AppError('NOT_FOUND', 404, 'Not found');
    return toProfile(updated);
  }

  profileFrom(auth: AuthContext): ProfileResponse {
    return {
      id: auth.userId,
      email: auth.email,
      displayName: auth.displayName,
      status: auth.status,
      emailVerified: auth.emailVerifiedAt !== null,
      emailVerifiedAt: auth.emailVerifiedAt,
      createdAt: auth.createdAt,
      roles: [...auth.roles],
      mfaEnrolled: auth.mfaEnrolled,
    };
  }

  async inviteStaff(
    auth: AuthContext,
    input: { email: string; role: StaffRoleCode; password: string; totp: string },
    meta: RequestMeta,
  ): Promise<void> {
    this.requireDelivery();
    await this.reauthenticate(auth, input.password, input.totp);
    if (await this.repository.emailExists(input.email)) {
      throw new AppError(
        'CONFLICT',
        409,
        'An account with that email already exists. Assign a role instead.',
      );
    }
    const token = newOpaqueToken();
    await this.repository.transaction(async (client) => {
      await this.repository.revokeOpenInvitations(client, input.email);
      await this.repository.insertInvitation(client, {
        email: input.email,
        role: input.role,
        tokenHash: hashToken(token),
        invitedBy: auth.userId,
        expiresAt: expiresAt(INVITATION_TTL_MS),
      });
      await this.repository.insertAudit(
        {
          eventType: 'staff.invited',
          actorUserId: auth.userId,
          targetUserId: null,
          ip: meta.ip,
          userAgent: clipAgent(meta.userAgent),
          metadata: { role: input.role },
        },
        client,
      );
    });
    const delivery = await this.deliver({
      to: input.email,
      subject: 'K2 Group staff invitation',
      purpose: 'staff.invite',
      text: `You have been invited to K2 Group as ${input.role}.\n\n${this.link('/invitations/accept', token)}\n\nThis link expires in 48 hours and can be used once. Staff tools stay locked until multi-factor authentication is enrolled.\n`,
    });
    if (delivery === 'failed') {
      await this.repository.transaction(async (client) => {
        await this.repository.markInvitationRevoked(client, hashToken(token));
      });
      throw new AppError('EMAIL_DELIVERY_UNAVAILABLE', 503, 'Email delivery failed');
    }
  }

  async acceptInvitation(token: string, password: string, meta: RequestMeta): Promise<void> {
    this.consume(`invite:${meta.ip ?? 'unknown'}`, 10, HOUR_MS);
    const passwordHash = await hashPassword(password);
    const tokenHash = hashToken(token);
    const accepted = await this.repository.transaction(async (client) => {
      const invitation = await this.repository.lockInvitation(client, tokenHash);
      if (!invitation) return false;
      if (await this.repository.emailExists(invitation.email, client)) {
        await this.repository.markInvitationRevoked(client, tokenHash);
        await this.repository.insertAudit(
          {
            eventType: 'staff.invitation_rejected',
            actorUserId: invitation.invitedBy,
            targetUserId: null,
            ip: meta.ip,
            userAgent: clipAgent(meta.userAgent),
            metadata: { reason: 'email_in_use' },
          },
          client,
        );
        return false;
      }
      const userId = await this.repository.insertUser(client, {
        email: invitation.email,
        passwordHash,
        parameters: ARGON2_PARAMETERS,
        role: invitation.roleCode,
        grantedBy: invitation.invitedBy,
        emailVerified: true,
      });
      await this.repository.markInvitationAccepted(client, tokenHash);
      await this.repository.insertAudit(
        {
          eventType: 'staff.invitation_accepted',
          actorUserId: userId,
          targetUserId: userId,
          ip: meta.ip,
          userAgent: clipAgent(meta.userAgent),
          metadata: { role: invitation.roleCode },
        },
        client,
      );
      return true;
    });
    if (!accepted) {
      throw new AppError('VALIDATION_ERROR', 400, 'This invitation is invalid or expired.');
    }
  }

  async staffProfile(userId: string): Promise<ProfileResponse> {
    const profile = await this.repository.findProfile(userId);
    if (!profile) throw new AppError('NOT_FOUND', 404, 'Not found');
    return toProfile(profile);
  }

  async changeRoles(
    auth: AuthContext,
    targetId: string,
    roles: readonly RoleCode[],
    password: string,
    totp: string,
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    if (auth.userId === targetId) {
      throw new AppError('FORBIDDEN', 403, 'You cannot change your own roles');
    }
    await this.reauthenticate(auth, password, totp);
    const before = await this.repository.findProfile(targetId);
    if (!before) throw new AppError('NOT_FOUND', 404, 'Not found');
    await this.repository.transaction(async (client) => {
      const locked = await this.repository.lockUser(client, targetId);
      if (!locked) throw new AppError('NOT_FOUND', 404, 'Not found');
      await this.repository.lockAdminRows(client);
      const removesLastAdmin =
        before.roles.includes('ADMIN') &&
        !roles.includes('ADMIN') &&
        (await this.repository.countAdmins(client)) <= 1;
      if (removesLastAdmin) {
        throw new AppError('CONFLICT', 409, 'The last administrator cannot be removed');
      }
      await this.repository.replaceRoles(client, targetId, roles, auth.userId);
      await this.repository.revokeAll(targetId, client);
      await this.repository.revokeExact(client, auth.userId, auth.sessionId);
      await this.repository.insertAudit(
        {
          eventType: 'staff.roles_changed',
          actorUserId: auth.userId,
          targetUserId: targetId,
          ip: meta.ip,
          userAgent: clipAgent(meta.userAgent),
          metadata: {
            previousRoles: before.roles.join(','),
            nextRoles: roles.join(','),
          },
        },
        client,
      );
    });
    return this.repository.transaction((client) =>
      this.issue(client, {
        userId: auth.userId,
        kind: 'full',
        ttlMs: SESSION_ABSOLUTE_MS,
        meta,
        rotatedFromId: auth.sessionId,
        mfaVerifiedAt: new Date(),
      }),
    );
  }

  async changeStatus(
    auth: AuthContext,
    targetId: string,
    status: AccountStatus,
    password: string,
    totp: string,
    meta: RequestMeta,
  ): Promise<void> {
    if (auth.userId === targetId) {
      throw new AppError('FORBIDDEN', 403, 'You cannot change your own account status');
    }
    await this.reauthenticate(auth, password, totp);
    await this.repository.transaction(async (client) => {
      const locked = await this.repository.lockUser(client, targetId);
      if (!locked) throw new AppError('NOT_FOUND', 404, 'Not found');
      if (!allowedTransition(locked.status, status)) {
        throw new AppError('CONFLICT', 409, 'That account status change is not allowed');
      }
      if (locked.status === 'ACTIVE' && status !== 'ACTIVE') {
        await this.repository.lockAdminRows(client);
        const isAdmin = await this.repository.userHasRole(client, targetId, 'ADMIN');
        if (isAdmin && (await this.repository.countAdmins(client)) <= 1) {
          throw new AppError('CONFLICT', 409, 'The last administrator cannot be removed');
        }
      }
      await this.repository.updateStatus(client, targetId, status);
      if (status !== 'ACTIVE') await this.repository.revokeAll(targetId, client);
      await this.repository.insertAudit(
        {
          eventType: 'staff.status_changed',
          actorUserId: auth.userId,
          targetUserId: targetId,
          ip: meta.ip,
          userAgent: clipAgent(meta.userAgent),
          metadata: { previousStatus: locked.status, nextStatus: status },
        },
        client,
      );
    });
  }

  async resetStaffMfa(
    auth: AuthContext,
    targetId: string,
    password: string,
    totp: string,
    meta: RequestMeta,
  ): Promise<void> {
    if (auth.userId === targetId) {
      throw new AppError('FORBIDDEN', 403, 'You cannot reset your own multi-factor authentication');
    }
    await this.reauthenticate(auth, password, totp);
    const profile = await this.repository.findProfile(targetId);
    if (!profile) throw new AppError('NOT_FOUND', 404, 'Not found');
    await this.repository.transaction(async (client) => {
      await this.repository.disableFactors(client, targetId);
      await this.repository.revokeAll(targetId, client);
      await this.repository.insertAudit(
        {
          eventType: 'staff.mfa_reset',
          actorUserId: auth.userId,
          targetUserId: targetId,
          ip: meta.ip,
          userAgent: clipAgent(meta.userAgent),
          metadata: {},
        },
        client,
      );
    });
  }

  async listAudit(): Promise<
    {
      id: string;
      eventType: string;
      actorUserId: string | null;
      targetUserId: string | null;
      ip: string | null;
      createdAt: string;
      metadata: AuditEvent['metadata'];
    }[]
  > {
    const events = await this.repository.listAudit();
    return events.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      actorUserId: event.actorUserId,
      targetUserId: event.targetUserId,
      ip: event.ip,
      createdAt: event.createdAt.toISOString(),
      metadata: event.metadata,
    }));
  }

  private async readPending(
    token: string | null,
    csrf: string | null,
  ): Promise<{
    sessionId: string;
    userId: string;
    email: string;
  } | null> {
    if (!token || !csrf) return null;
    const tokenHash = hashToken(token);
    await this.repository.expireIfDue(tokenHash, 'mfa_pending', MFA_CHALLENGE_IDLE_SECONDS);
    const pending = await this.repository.findPendingSession(tokenHash, MFA_CHALLENGE_IDLE_SECONDS);
    if (!pending || pending.status !== 'ACTIVE') return null;
    if (!tokensMatch(hashToken(csrf), pending.csrfHash)) return null;
    return pending;
  }

  private async reauthenticate(auth: AuthContext, password: string, totp: string): Promise<void> {
    const user = await this.repository.findUserByEmail(auth.email);
    if (!user || !(await verifyPassword(user.passwordHash, password))) {
      throw new AppError('AUTHENTICATION_FAILED', 401, 'Email or password is incorrect');
    }
    await this.assertConfirmedTotp(auth.userId, auth.email, totp);
  }

  private async assertConfirmedTotp(userId: string, email: string, code: string): Promise<void> {
    this.guardMfa(userId);
    const factor = await this.repository.findConfirmedFactor(userId);
    const secret = factor
      ? decryptSecret(
          this.config.mfaEncryptionKey,
          { ciphertext: factor.ciphertext, nonce: factor.nonce },
          userId,
        )
      : null;
    if (!factor || !secret || !totpValid(email, secret, code)) {
      this.limiter.recordFailure(mfaKey(userId), MFA_WINDOW_MS);
      throw new AppError('AUTHENTICATION_FAILED', 401, 'The authentication code is incorrect');
    }
  }

  private guardMfa(userId: string): void {
    if (this.limiter.failureCount(mfaKey(userId), MFA_WINDOW_MS) >= MFA_ATTEMPT_LIMIT) {
      throw failureLimit(mfaKey(userId), this.limiter, MFA_WINDOW_MS);
    }
  }

  private async issue(
    client: Parameters<IdentityRepository['createSession']>[0],
    input: {
      userId: string;
      kind: 'full' | 'mfa_pending';
      ttlMs: number;
      meta: RequestMeta;
      rotatedFromId: string | null;
      mfaVerifiedAt: Date | null;
    },
  ): Promise<IssuedSession> {
    const token = newOpaqueToken();
    const csrf = newOpaqueToken();
    const created = await this.repository.createSession(client, {
      userId: input.userId,
      tokenHash: hashToken(token),
      csrfHash: hashToken(csrf),
      kind: input.kind,
      expiresAt: expiresAt(input.ttlMs),
      ip: input.meta.ip,
      userAgent: clipAgent(input.meta.userAgent),
      rotatedFromId: input.rotatedFromId,
      mfaVerifiedAt: input.mfaVerifiedAt,
    });
    return { token, csrf, sessionId: created.id, expiresAt: created.expiresAt };
  }

  private async notify(
    userId: string,
    message: { subject: string; purpose: string; text: string },
  ): Promise<'sent' | 'unavailable'> {
    if (!this.email.canSend) return 'unavailable';
    const profile = await this.repository.findProfile(userId);
    if (!profile) return 'unavailable';
    const delivery = await this.deliver({ to: profile.email, ...message });
    return delivery === 'sent' ? 'sent' : 'unavailable';
  }

  private async deliver(message: EmailMessage): Promise<'sent' | 'failed'> {
    try {
      await this.email.send(message);
      return 'sent';
    } catch (error) {
      this.logger?.error(
        {
          event: 'email_delivery_failed',
          name: error instanceof Error ? error.name : 'Error',
        },
        'email delivery failed',
      );
      return 'failed';
    }
  }

  private link(pathname: string, token: string): string {
    return `${this.config.webOrigin}${pathname}#${token}`;
  }

  private requireDelivery(): void {
    if (!this.email.canSend) {
      throw new AppError('EMAIL_DELIVERY_UNAVAILABLE', 503, 'Email delivery is not configured');
    }
  }

  private consume(key: string, limit: number, windowMs: number): void {
    const decision = this.limiter.consume(key, limit, windowMs);
    if (!decision.ok) throw new RateLimitError(decision.retryAfterSeconds);
  }

  private async dummyHash(): Promise<string> {
    this.dummyHashPromise ??= hashPassword(randomBytes(32).toString('base64url'));
    return this.dummyHashPromise;
  }
}

function toContext(row: SessionContext): AuthContext {
  return {
    userId: row.userId,
    sessionId: row.sessionId,
    email: row.email,
    displayName: row.displayName,
    status: row.status,
    emailVerifiedAt: row.emailVerifiedAt ? row.emailVerifiedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    roles: row.roles,
    permissions: new Set(row.permissions),
    staff: row.staff,
    mfaEnrolled: row.mfaEnrolled,
    mfaSatisfied: row.mfaVerifiedAt !== null,
    csrfHash: row.csrfHash,
    expiresAt: row.expiresAt.toISOString(),
  };
}

function toProfile(record: ProfileRecord): ProfileResponse {
  return {
    id: record.id,
    email: record.email,
    displayName: record.displayName,
    status: record.status,
    emailVerified: record.emailVerifiedAt !== null,
    emailVerifiedAt: record.emailVerifiedAt ? record.emailVerifiedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    roles: [...record.roles],
    mfaEnrolled: record.mfaEnrolled,
  };
}

function allowedTransition(from: AccountStatus, to: AccountStatus): boolean {
  if (from === to || from === 'CLOSED') return false;
  if (from === 'ACTIVE') return to === 'SUSPENDED' || to === 'CLOSED';
  return to === 'ACTIVE' || to === 'CLOSED';
}

function clipAgent(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, 256);
}

function mfaKey(userId: string): string {
  return `mfa:${userId}`;
}

function failureLimit(
  key: string,
  limiter: MemoryRateLimiter,
  windowMs = LOGIN_FAILURE_WINDOW_MS,
): RateLimitError {
  const age = limiter.oldestFailureAgeMs(key, windowMs) ?? 0;
  return new RateLimitError(Math.max(1, Math.ceil((windowMs - age) / 1000)));
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
