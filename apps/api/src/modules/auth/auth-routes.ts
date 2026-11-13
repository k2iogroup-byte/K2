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
  sensitiveStaffProfileResponseSchema,
  sessionListResponseSchema,
  staffUserResponseSchema,
  statusChangeRequestSchema,
  statusUpdatedResponseSchema,
  tokenRequestSchema,
  verifiedResponseSchema,
} from '@k2/shared';
import { emptyQuerySchema } from '@k2/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';

import type { AppConfig } from '../../config/env.js';
import { IdentityRepository } from '../../infrastructure/db/identity-repository.js';
import { parseWithSchema } from '../../infrastructure/http/validation.js';
import { AuthService } from './auth-service.js';
import {
  applyAuthCookies,
  clearAuthCookies,
  csrfHeader,
  MFA_COOKIE,
  readOpaqueCookie,
  SESSION_COOKIE,
} from './cookies.js';
import type { EmailSender } from './email.js';
import { PostgresRateLimiter } from './postgres-rate-limit.js';
import type { RateLimiter } from './rate-limit.js';
import { PERMISSIONS, requirePermission, requireStaffAccess } from './rbac.js';
import {
  noStore,
  requestMeta,
  requireCsrf,
  requireMarker,
  requireRead,
  requireWrite,
  sendJson,
} from './request-context.js';

const idParamsSchema = z.strictObject({ id: z.uuid() });

export type AuthRouteOptions = {
  config: AppConfig;
  pool: pg.Pool;
  emailSender: EmailSender;
  limiter?: RateLimiter;
  sleep?: (ms: number) => Promise<void>;
};

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): AuthService {
  const service = new AuthService(
    new IdentityRepository(options.pool),
    options.emailSender,
    options.limiter ?? new PostgresRateLimiter(options.pool),
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
    return sendJson(reply, 200, authMeResponseSchema, {
      profile: await service.ownProfile(auth.userId),
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
    return sendJson(reply, 200, sessionListResponseSchema, {
      sessions: await service.listSessions(auth),
    });
  });

  app.get('/users/me', async (request, reply) => {
    noStore(reply);
    parseWithSchema(emptyQuerySchema, request.query);
    const auth = await requireRead(service, request);
    requirePermission(auth, PERMISSIONS.profileRead);
    return sendJson(reply, 200, profileResponseSchema, await service.ownProfile(auth.userId));
  });

  app.get('/staff/users/:id', async (request, reply) => {
    noStore(reply);
    parseWithSchema(emptyQuerySchema, request.query);
    const auth = await requireRead(service, request);
    requireStaffAccess(auth, PERMISSIONS.staffUsersRead);
    const params = parseWithSchema(idParamsSchema, request.params);
    return sendJson(reply, 200, staffUserResponseSchema, await service.staffProfile(params.id));
  });

  app.get('/staff/users/:id/sensitive', async (request, reply) => {
    noStore(reply);
    parseWithSchema(emptyQuerySchema, request.query);
    const auth = await requireRead(service, request);
    requireStaffAccess(auth, PERMISSIONS.staffUsersSensitiveRead);
    const params = parseWithSchema(idParamsSchema, request.params);
    return sendJson(
      reply,
      200,
      sensitiveStaffProfileResponseSchema,
      await service.sensitiveStaffProfile(auth, params.id, requestMeta(request)),
    );
  });

  app.get('/staff/audit', async (request, reply) => {
    noStore(reply);
    parseWithSchema(emptyQuerySchema, request.query);
    const auth = await requireRead(service, request);
    requireStaffAccess(auth, PERMISSIONS.auditRead);
    return sendJson(reply, 200, auditListResponseSchema, { events: await service.listAudit() });
  });

  app.post('/auth/register', async (request, reply) => {
    noStore(reply);
    requireMarker(request);
    parseWithSchema(emptyQuerySchema, request.query);
    const body = parseWithSchema(registerRequestSchema, request.body);
    await service.register(body, requestMeta(request));
    return sendJson(reply, 202, acceptedResponseSchema, { status: 'accepted' });
  });

  app.post('/auth/login', async (request, reply) => {
    noStore(reply);
    requireMarker(request);
    parseWithSchema(emptyQuerySchema, request.query);
    const body = parseWithSchema(loginRequestSchema, request.body);
    const result = await service.login(
      'email' in body
        ? { kind: 'email', email: body.email }
        : { kind: 'username', username: body.username },
      body.password,
      requestMeta(request),
      readOpaqueCookie(request, SESSION_COOKIE),
    );
    applyAuthCookies(reply, options.config, result.session, result.kind);
    return sendJson(reply, 200, loginResponseSchema, {
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
    return sendJson(reply, 200, loggedOutResponseSchema, { status: 'logged_out' });
  });

  app.post('/auth/email/verify', async (request, reply) => {
    noStore(reply);
    requireMarker(request);
    parseWithSchema(emptyQuerySchema, request.query);
    const body = parseWithSchema(tokenRequestSchema, request.body);
    await service.verifyEmail(body.token, requestMeta(request));
    return sendJson(reply, 200, verifiedResponseSchema, { status: 'verified' });
  });

  app.post('/auth/email/resend', async (request, reply) => {
    noStore(reply);
    requireMarker(request);
    parseWithSchema(emptyQuerySchema, request.query);
    const body = parseWithSchema(emailRequestSchema, request.body);
    await service.resendVerification(body.email, requestMeta(request));
    return sendJson(reply, 202, acceptedResponseSchema, { status: 'accepted' });
  });

  app.post('/auth/password/forgot', async (request, reply) => {
    noStore(reply);
    requireMarker(request);
    parseWithSchema(emptyQuerySchema, request.query);
    const body = parseWithSchema(emailRequestSchema, request.body);
    await service.forgotPassword(body.email, requestMeta(request));
    return sendJson(reply, 202, acceptedResponseSchema, { status: 'accepted' });
  });

  app.post('/auth/password/reset', async (request, reply) => {
    noStore(reply);
    requireMarker(request);
    parseWithSchema(emptyQuerySchema, request.query);
    const body = parseWithSchema(resetPasswordRequestSchema, request.body);
    const notification = await service.resetPassword(
      body.token,
      body.password,
      requestMeta(request),
    );
    clearAuthCookies(reply, options.config);
    return sendJson(reply, 200, passwordResultResponseSchema, { status: 'reset', notification });
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
      requestMeta(request),
    );
    applyAuthCookies(reply, options.config, result.session, 'full');
    return sendJson(reply, 200, passwordResultResponseSchema, {
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
    return sendJson(reply, 200, revokedResponseSchema, { status: 'revoked', revokedCount });
  });

  app.delete('/auth/sessions', async (request, reply) => {
    noStore(reply);
    parseWithSchema(emptyQuerySchema, request.query);
    const auth = await requireWrite(service, request);
    requirePermission(auth, PERMISSIONS.sessionRevoke);
    const revokedCount = await service.revokeOthers(auth);
    return sendJson(reply, 200, revokedResponseSchema, { status: 'revoked', revokedCount });
  });

  app.post('/auth/mfa/enroll', async (request, reply) => {
    noStore(reply);
    parseWithSchema(emptyQuerySchema, request.query);
    const auth = await requireWrite(service, request);
    requirePermission(auth, PERMISSIONS.mfaEnroll);
    const enrolled = await service.enrollMfa(auth);
    return sendJson(reply, 200, mfaEnrollResponseSchema, enrolled);
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
      const session = await service.confirmEnrollment(auth, body.code, requestMeta(request));
      applyAuthCookies(reply, options.config, session, 'full');
      return sendJson(reply, 200, mfaVerifiedResponseSchema, { status: 'verified' });
    }
    const session = await service.completeMfa(
      readOpaqueCookie(request, MFA_COOKIE),
      csrfHeader(request),
      body.code,
      requestMeta(request),
    );
    applyAuthCookies(reply, options.config, session, 'full');
    return sendJson(reply, 200, loginResponseSchema, {
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
      requestMeta(request),
    );
    applyAuthCookies(reply, options.config, session, 'full');
    return sendJson(reply, 200, loginResponseSchema, {
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
    const session = await service.disableMfa(auth, body.password, body.totp, requestMeta(request));
    applyAuthCookies(reply, options.config, session, 'full');
    return sendJson(reply, 200, mfaVerifiedResponseSchema, { status: 'verified' });
  });

  app.patch('/users/me', async (request, reply) => {
    noStore(reply);
    parseWithSchema(emptyQuerySchema, request.query);
    const auth = await requireWrite(service, request);
    requirePermission(auth, PERMISSIONS.profileUpdate);
    const body = parseWithSchema(profilePatchSchema, request.body);
    return sendJson(
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
    await service.inviteStaff(auth, body, requestMeta(request));
    return sendJson(reply, 202, invitedResponseSchema, { status: 'invited' });
  });

  app.post('/auth/invitations/accept', async (request, reply) => {
    noStore(reply);
    requireMarker(request);
    parseWithSchema(emptyQuerySchema, request.query);
    const body = parseWithSchema(acceptInvitationRequestSchema, request.body);
    await service.acceptInvitation(body.token, body.password, requestMeta(request));
    return sendJson(reply, 201, acceptedResponseSchema, { status: 'accepted' });
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
      requestMeta(request),
    );
    applyAuthCookies(reply, options.config, session, 'full');
    return sendJson(reply, 200, rolesUpdatedResponseSchema, {
      status: 'updated',
      roles: body.roles,
    });
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
      requestMeta(request),
    );
    return sendJson(reply, 200, statusUpdatedResponseSchema, {
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
    await service.resetStaffMfa(auth, params.id, body.password, body.totp, requestMeta(request));
    return sendJson(reply, 200, mfaVerifiedResponseSchema, { status: 'verified' });
  });
  return service;
}
