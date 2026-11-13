import {
  acceptedResponseSchema,
  acceptInvitationRequestSchema,
  auditListResponseSchema,
  authMeResponseSchema,
  changePasswordRequestSchema,
  emailRequestSchema,
  invitationRequestSchema,
  invitedResponseSchema,
  loggedOutResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  mfaCodeRequestSchema,
  mfaDisableRequestSchema,
  mfaEnrollResponseSchema,
  mfaVerifiedResponseSchema,
  passwordResultResponseSchema,
  profilePatchSchema,
  profileResponseSchema,
  recoveryCodeRequestSchema,
  registerRequestSchema,
  resetPasswordRequestSchema,
  revokedResponseSchema,
  roleAssignmentRequestSchema,
  rolesUpdatedResponseSchema,
  sessionListResponseSchema,
  statusChangeRequestSchema,
  statusUpdatedResponseSchema,
  tokenRequestSchema,
  verifiedResponseSchema,
} from '@k2/shared';
import { emptyQuerySchema } from '@k2/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { ZodType } from 'zod';
import { z } from 'zod';

import type { AppConfig } from '../../config/env.js';
import { IdentityRepository } from '../../infrastructure/db/identity-repository.js';
import { AppError } from '../../infrastructure/http/errors.js';
import { parseWithSchema } from '../../infrastructure/http/validation.js';
import type { RequestMeta } from './auth-service.js';
import { AuthService } from './auth-service.js';
import {
  applyAuthCookies,
  clearAuthCookies,
  csrfHeader,
  MFA_COOKIE,
  readOpaqueCookie,
  requestMarkerPresent,
  SESSION_COOKIE,
} from './cookies.js';
import type { EmailSender } from './email.js';
import type { MemoryRateLimiter } from './rate-limit.js';
import { MemoryRateLimiter as DefaultLimiter } from './rate-limit.js';
import type { AuthContext } from './rbac.js';
import { PERMISSIONS, requirePermission, requireStaffAccess } from './rbac.js';
import { hashToken, tokensMatch } from './tokens.js';

const idParamsSchema = z.strictObject({ id: z.uuid() });

export type AuthRouteOptions = {
  config: AppConfig;
  pool: pg.Pool;
  emailSender: EmailSender;
  limiter?: MemoryRateLimiter;
  sleep?: (ms: number) => Promise<void>;
};

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const service = new AuthService(
    new IdentityRepository(options.pool),
    options.emailSender,
    options.limiter ?? new DefaultLimiter(),
    options.config,
    options.sleep,
    {
      error(object, message) {
        app.log.error(object, message);
      },
    },
  );

  app.get('/auth/me', async (request, reply) => {
    noStore(reply);
    parseWithSchema(emptyQuerySchema, request.query);
    const auth = await requireRead(service, request);
    return send(reply, 200, authMeResponseSchema, {
      profile: service.profileFrom(auth),
      staff: auth.staff,
      mfaSatisfied: auth.mfaSatisfied,
      permissions: [...auth.permissions],
      session: { id: auth.sessionId, expiresAt: auth.expiresAt },
    });
  });

  app.get('/auth/sessions', async (request, reply) => {
    noStore(reply);
    parseWithSchema(emptyQuerySchema, request.query);
    const auth = await requireRead(service, request);
    requirePermission(auth, PERMISSIONS.sessionList);
    return send(reply, 200, sessionListResponseSchema, {
      sessions: await service.listSessions(auth),
    });
  });

  app.get('/users/me', async (request, reply) => {
    noStore(reply);
    parseWithSchema(emptyQuerySchema, request.query);
    const auth = await requireRead(service, request);
    requirePermission(auth, PERMISSIONS.profileRead);
    return send(reply, 200, profileResponseSchema, service.profileFrom(auth));
  });

  app.get('/staff/users/:id', async (request, reply) => {
    noStore(reply);
    parseWithSchema(emptyQuerySchema, request.query);
    const auth = await requireRead(service, request);
    requireStaffAccess(auth, PERMISSIONS.staffUsersRead);
    const params = parseWithSchema(idParamsSchema, request.params);
    return send(reply, 200, profileResponseSchema, await service.staffProfile(params.id));
  });

  app.get('/staff/audit', async (request, reply) => {
    noStore(reply);
    parseWithSchema(emptyQuerySchema, request.query);
    const auth = await requireRead(service, request);
    requireStaffAccess(auth, PERMISSIONS.auditRead);
    return send(reply, 200, auditListResponseSchema, { events: await service.listAudit() });
  });

  app.post('/auth/register', async (request, reply) => {
    noStore(reply);
    requireMarker(request);
    parseWithSchema(emptyQuerySchema, request.query);
    const body = parseWithSchema(registerRequestSchema, request.body);
    await service.register(body.email, body.password, meta(request));
    return send(reply, 202, acceptedResponseSchema, { status: 'accepted' });
  });

  app.post('/auth/login', async (request, reply) => {
    noStore(reply);
    requireMarker(request);
    parseWithSchema(emptyQuerySchema, request.query);
    const body = parseWithSchema(loginRequestSchema, request.body);
    const result = await service.login(
      body.email,
      body.password,
      meta(request),
      readOpaqueCookie(request, SESSION_COOKIE),
    );
    applyAuthCookies(reply, options.config, result.session, result.kind);
    return send(reply, 200, loginResponseSchema, {
      status: result.kind === 'mfa' ? 'mfa_required' : 'authenticated',
      mfaRequired: result.kind === 'mfa',
    });
  });

  app.post('/auth/logout', async (request, reply) => {
    noStore(reply);
    requireMarker(request);
    parseWithSchema(emptyQuerySchema, request.query);
    const auth = await service.loadSession(readOpaqueCookie(request, SESSION_COOKIE));
    if (auth) requireCsrf(request, auth);
    await service.logout(auth);
    clearAuthCookies(reply, options.config);
    return send(reply, 200, loggedOutResponseSchema, { status: 'logged_out' });
  });

  app.post('/auth/email/verify', async (request, reply) => {
    noStore(reply);
    requireMarker(request);
    parseWithSchema(emptyQuerySchema, request.query);
    const body = parseWithSchema(tokenRequestSchema, request.body);
    await service.verifyEmail(body.token, meta(request));
    return send(reply, 200, verifiedResponseSchema, { status: 'verified' });
  });

  app.post('/auth/email/resend', async (request, reply) => {
    noStore(reply);
    requireMarker(request);
    parseWithSchema(emptyQuerySchema, request.query);
    const body = parseWithSchema(emailRequestSchema, request.body);
    await service.resendVerification(body.email, meta(request));
    return send(reply, 202, acceptedResponseSchema, { status: 'accepted' });
  });

  app.post('/auth/password/forgot', async (request, reply) => {
    noStore(reply);
    requireMarker(request);
    parseWithSchema(emptyQuerySchema, request.query);
    const body = parseWithSchema(emailRequestSchema, request.body);
    await service.forgotPassword(body.email, meta(request));
    return send(reply, 202, acceptedResponseSchema, { status: 'accepted' });
  });

  app.post('/auth/password/reset', async (request, reply) => {
    noStore(reply);
    requireMarker(request);
    parseWithSchema(emptyQuerySchema, request.query);
    const body = parseWithSchema(resetPasswordRequestSchema, request.body);
    const notification = await service.resetPassword(body.token, body.password, meta(request));
    clearAuthCookies(reply, options.config);
    return send(reply, 200, passwordResultResponseSchema, { status: 'reset', notification });
  });

  app.post('/auth/password/change', async (request, reply) => {
    noStore(reply);
    parseWithSchema(emptyQuerySchema, request.query);
    const auth = await requireWrite(service, request);
    requirePermission(auth, PERMISSIONS.passwordChange);
    const body = parseWithSchema(changePasswordRequestSchema, request.body);
    const result = await service.changePassword(
      auth,
      body.currentPassword,
      body.newPassword,
      body.totp,
      meta(request),
    );
    applyAuthCookies(reply, options.config, result.session, 'full');
    return send(reply, 200, passwordResultResponseSchema, {
      status: 'changed',
      notification: result.notification,
    });
  });

  app.delete('/auth/sessions/:id', async (request, reply) => {
    noStore(reply);
    const auth = await requireWrite(service, request);
    requirePermission(auth, PERMISSIONS.sessionRevoke);
    const params = parseWithSchema(idParamsSchema, request.params);
    const revokedCount = await service.revokeOne(auth, params.id);
    if (params.id === auth.sessionId) clearAuthCookies(reply, options.config);
    return send(reply, 200, revokedResponseSchema, { status: 'revoked', revokedCount });
  });

  app.delete('/auth/sessions', async (request, reply) => {
    noStore(reply);
    parseWithSchema(emptyQuerySchema, request.query);
    const auth = await requireWrite(service, request);
    requirePermission(auth, PERMISSIONS.sessionRevoke);
    const revokedCount = await service.revokeOthers(auth);
    return send(reply, 200, revokedResponseSchema, { status: 'revoked', revokedCount });
  });

  app.post('/auth/mfa/enroll', async (request, reply) => {
    noStore(reply);
    parseWithSchema(emptyQuerySchema, request.query);
    const auth = await requireWrite(service, request);
    requirePermission(auth, PERMISSIONS.mfaEnroll);
    const enrolled = await service.enrollMfa(auth);
    return send(reply, 200, mfaEnrollResponseSchema, enrolled);
  });

  app.post('/auth/mfa/verify', async (request, reply) => {
    noStore(reply);
    requireMarker(request);
    parseWithSchema(emptyQuerySchema, request.query);
    const body = parseWithSchema(mfaCodeRequestSchema, request.body);
    const auth = await service.loadSession(readOpaqueCookie(request, SESSION_COOKIE));
    if (auth) {
      requireCsrf(request, auth);
      requirePermission(auth, PERMISSIONS.mfaEnroll);
      const session = await service.confirmEnrollment(auth, body.code, meta(request));
      applyAuthCookies(reply, options.config, session, 'full');
      return send(reply, 200, mfaVerifiedResponseSchema, { status: 'verified' });
    }
    const session = await service.completeMfa(
      readOpaqueCookie(request, MFA_COOKIE),
      csrfHeader(request),
      body.code,
      meta(request),
    );
    applyAuthCookies(reply, options.config, session, 'full');
    return send(reply, 200, loginResponseSchema, {
      status: 'authenticated',
      mfaRequired: false,
    });
  });

  app.post('/auth/mfa/recovery', async (request, reply) => {
    noStore(reply);
    requireMarker(request);
    parseWithSchema(emptyQuerySchema, request.query);
    const body = parseWithSchema(recoveryCodeRequestSchema, request.body);
    const session = await service.recoverMfa(
      readOpaqueCookie(request, MFA_COOKIE),
      csrfHeader(request),
      body.code,
      meta(request),
    );
    applyAuthCookies(reply, options.config, session, 'full');
    return send(reply, 200, loginResponseSchema, {
      status: 'authenticated',
      mfaRequired: false,
    });
  });

  app.post('/auth/mfa/disable', async (request, reply) => {
    noStore(reply);
    parseWithSchema(emptyQuerySchema, request.query);
    const auth = await requireWrite(service, request);
    requirePermission(auth, PERMISSIONS.mfaEnroll);
    const body = parseWithSchema(mfaDisableRequestSchema, request.body);
    const session = await service.disableMfa(auth, body.password, body.totp, meta(request));
    applyAuthCookies(reply, options.config, session, 'full');
    return send(reply, 200, mfaVerifiedResponseSchema, { status: 'verified' });
  });

  app.patch('/users/me', async (request, reply) => {
    noStore(reply);
    parseWithSchema(emptyQuerySchema, request.query);
    const auth = await requireWrite(service, request);
    requirePermission(auth, PERMISSIONS.profileUpdate);
    const body = parseWithSchema(profilePatchSchema, request.body);
    return send(
      reply,
      200,
      profileResponseSchema,
      await service.updateProfile(auth, body.displayName),
    );
  });

  app.post('/staff/invitations', async (request, reply) => {
    noStore(reply);
    parseWithSchema(emptyQuerySchema, request.query);
    const auth = await requireWrite(service, request);
    requireStaffAccess(auth, PERMISSIONS.staffInvite);
    const body = parseWithSchema(invitationRequestSchema, request.body);
    await service.inviteStaff(auth, body, meta(request));
    return send(reply, 202, invitedResponseSchema, { status: 'invited' });
  });

  app.post('/auth/invitations/accept', async (request, reply) => {
    noStore(reply);
    requireMarker(request);
    parseWithSchema(emptyQuerySchema, request.query);
    const body = parseWithSchema(acceptInvitationRequestSchema, request.body);
    await service.acceptInvitation(body.token, body.password, meta(request));
    return send(reply, 201, acceptedResponseSchema, { status: 'accepted' });
  });

  app.post('/staff/users/:id/roles', async (request, reply) => {
    noStore(reply);
    const auth = await requireWrite(service, request);
    requireStaffAccess(auth, PERMISSIONS.staffRolesAssign);
    const params = parseWithSchema(idParamsSchema, request.params);
    const body = parseWithSchema(roleAssignmentRequestSchema, request.body);
    const session = await service.changeRoles(
      auth,
      params.id,
      body.roles,
      body.password,
      body.totp,
      meta(request),
    );
    applyAuthCookies(reply, options.config, session, 'full');
    return send(reply, 200, rolesUpdatedResponseSchema, { status: 'updated', roles: body.roles });
  });

  app.post('/staff/users/:id/status', async (request, reply) => {
    noStore(reply);
    const auth = await requireWrite(service, request);
    requireStaffAccess(auth, PERMISSIONS.staffStatusChange);
    const params = parseWithSchema(idParamsSchema, request.params);
    const body = parseWithSchema(statusChangeRequestSchema, request.body);
    await service.changeStatus(
      auth,
      params.id,
      body.status,
      body.password,
      body.totp,
      meta(request),
    );
    return send(reply, 200, statusUpdatedResponseSchema, {
      status: 'updated',
      accountStatus: body.status,
    });
  });

  app.post('/staff/users/:id/mfa/reset', async (request, reply) => {
    noStore(reply);
    const auth = await requireWrite(service, request);
    requireStaffAccess(auth, PERMISSIONS.staffMfaReset);
    const params = parseWithSchema(idParamsSchema, request.params);
    const body = parseWithSchema(mfaDisableRequestSchema, request.body);
    await service.resetStaffMfa(auth, params.id, body.password, body.totp, meta(request));
    return send(reply, 200, mfaVerifiedResponseSchema, { status: 'verified' });
  });
}

function requireMarker(request: FastifyRequest): void {
  parseWithSchema(emptyQuerySchema, request.query);
  if (!requestMarkerPresent(request)) {
    throw new AppError('CSRF_FAILED', 403, 'Request blocked');
  }
}

function requireCsrf(request: FastifyRequest, auth: AuthContext): void {
  if (!requestMarkerPresent(request)) {
    throw new AppError('CSRF_FAILED', 403, 'Request blocked');
  }
  const header = csrfHeader(request);
  if (!header || !tokensMatch(hashToken(header), auth.csrfHash)) {
    throw new AppError('CSRF_FAILED', 403, 'Request blocked');
  }
}

async function requireRead(service: AuthService, request: FastifyRequest): Promise<AuthContext> {
  parseWithSchema(emptyQuerySchema, request.query);
  const auth = await service.loadSession(readOpaqueCookie(request, SESSION_COOKIE));
  if (!auth) throw new AppError('AUTHENTICATION_FAILED', 401, 'Sign in is required');
  return auth;
}

async function requireWrite(service: AuthService, request: FastifyRequest): Promise<AuthContext> {
  const auth = await requireRead(service, request);
  requireCsrf(request, auth);
  return auth;
}

function meta(request: FastifyRequest): RequestMeta {
  const ip = request.ip.trim();
  const agent = request.headers['user-agent'];
  return {
    ip: ip === '' ? null : ip.slice(0, 64),
    userAgent: typeof agent === 'string' ? agent : null,
  };
}

function noStore(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
  reply.header('pragma', 'no-cache');
}

function send<T>(reply: FastifyReply, status: number, schema: ZodType<T>, body: T) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error('Response failed contract validation');
  return reply.status(status).send(parsed.data);
}
