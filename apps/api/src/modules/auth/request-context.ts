import { emptyQuerySchema } from '@k2/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';

import { AppError } from '../../infrastructure/http/errors.js';
import { parseWithSchema } from '../../infrastructure/http/validation.js';
import type { RequestMeta } from './auth-service.js';
import type { AuthService } from './auth-service.js';
import { readOpaqueCookie, requestMarkerPresent, SESSION_COOKIE } from './cookies.js';
import { csrfHeader } from './cookies.js';
import type { AuthContext } from './rbac.js';
import { hashToken, tokensMatch } from './tokens.js';

export function requireMarker(request: FastifyRequest): void {
  parseWithSchema(emptyQuerySchema, request.query);
  if (!requestMarkerPresent(request)) {
    throw new AppError('CSRF_FAILED', 403, 'Request blocked');
  }
}

export function requireCsrf(request: FastifyRequest, auth: AuthContext): void {
  if (!requestMarkerPresent(request)) {
    throw new AppError('CSRF_FAILED', 403, 'Request blocked');
  }
  const header = csrfHeader(request);
  if (!header || !tokensMatch(hashToken(header), auth.csrfHash)) {
    throw new AppError('CSRF_FAILED', 403, 'Request blocked');
  }
}

export async function requireRead(
  service: AuthService,
  request: FastifyRequest,
): Promise<AuthContext> {
  parseWithSchema(emptyQuerySchema, request.query);
  const auth = await service.loadSession(readOpaqueCookie(request, SESSION_COOKIE));
  if (!auth) throw new AppError('AUTHENTICATION_FAILED', 401, 'Sign in is required');
  return auth;
}

export async function requireWrite(
  service: AuthService,
  request: FastifyRequest,
): Promise<AuthContext> {
  const auth = await requireRead(service, request);
  requireCsrf(request, auth);
  return auth;
}

export function requestMeta(request: FastifyRequest): RequestMeta {
  const ip = request.ip.trim();
  const agent = request.headers['user-agent'];
  return {
    ip: ip === '' ? null : ip.slice(0, 64),
    userAgent: typeof agent === 'string' ? agent : null,
  };
}

export function noStore(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
  reply.header('pragma', 'no-cache');
}

export function sendJson<T>(
  reply: FastifyReply,
  status: number,
  schema: ZodType<T>,
  body: T,
): FastifyReply {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error('Response failed contract validation');
  return reply.status(status).send(parsed.data);
}
