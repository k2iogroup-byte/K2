export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
export const SESSION_IDLE_SECONDS = 60 * 60;
export const MFA_CHALLENGE_MS = 5 * 60 * 1000;
export const MFA_CHALLENGE_IDLE_SECONDS = 5 * 60;
export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;
export const INVITATION_TTL_MS = 48 * 60 * 60 * 1000;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_FAILURE_LIMIT = 8;

export function expiresAt(ttlMs: number, now = Date.now()): Date {
  return new Date(now + ttlMs);
}
