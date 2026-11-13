import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AppConfig } from '../../config/env.js';
import { tokensMatch } from './tokens.js';

export const SESSION_COOKIE = 'k2_session';
export const CSRF_COOKIE = 'k2_csrf';
export const MFA_COOKIE = 'k2_mfa';

const OPAQUE = /^[A-Za-z0-9_-]{43}$/;

export type CookieKind = 'full' | 'mfa';

export type IssuedCookie = {
  token: string;
  csrf: string;
  expiresAt: Date;
};

function secure(config: Pick<AppConfig, 'appEnv'>): boolean {
  return config.appEnv !== 'development';
}

export function applyAuthCookies(
  reply: FastifyReply,
  config: Pick<AppConfig, 'appEnv'>,
  issued: IssuedCookie,
  kind: CookieKind,
): void {
  const maxAge = Math.max(1, Math.floor((issued.expiresAt.getTime() - Date.now()) / 1000));
  const shared = {
    secure: secure(config),
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  };
  reply.setCookie(CSRF_COOKIE, issued.csrf, { ...shared, httpOnly: false });
  if (kind === 'full') {
    reply.setCookie(SESSION_COOKIE, issued.token, { ...shared, httpOnly: true });
    reply.clearCookie(MFA_COOKIE, {
      path: '/',
      sameSite: 'lax',
      secure: shared.secure,
      httpOnly: true,
    });
    return;
  }
  reply.setCookie(MFA_COOKIE, issued.token, { ...shared, httpOnly: true });
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    sameSite: 'lax',
    secure: shared.secure,
    httpOnly: true,
  });
}

export function clearAuthCookies(reply: FastifyReply, config: Pick<AppConfig, 'appEnv'>): void {
  const options = {
    path: '/',
    sameSite: 'lax' as const,
    secure: secure(config),
  };
  reply.clearCookie(SESSION_COOKIE, { ...options, httpOnly: true });
  reply.clearCookie(MFA_COOKIE, { ...options, httpOnly: true });
  reply.clearCookie(CSRF_COOKIE, { ...options, httpOnly: false });
}

export function readOpaqueCookie(request: FastifyRequest, name: string): string | null {
  const value = request.cookies[name];
  if (typeof value !== 'string' || !OPAQUE.test(value)) return null;
  return value;
}

export function requestMarkerPresent(request: FastifyRequest): boolean {
  return request.headers['x-k2-request'] === '1';
}

export function csrfHeader(request: FastifyRequest): string | null {
  const header = request.headers['x-csrf-token'];
  const cookie = request.cookies[CSRF_COOKIE];
  if (typeof header !== 'string' || typeof cookie !== 'string') return null;
  if (!OPAQUE.test(header) || !OPAQUE.test(cookie) || !tokensMatch(header, cookie)) return null;
  return header;
}
