/**
 * Browser WebSocket handshakes always send Origin. These endpoints have no
 * non-browser client today, so a missing Origin is rejected. HTTP CORS still
 * uses `isAllowedOrigin`, which allows a missing Origin for non-browser HTTP.
 */
export function socketOriginDecision(
  origin: string | undefined,
  allowed: readonly string[],
): { ok: true } | { ok: false; reason: 'origin required' | 'origin not allowed' } {
  if (origin === undefined || origin.trim() === '') {
    return { ok: false, reason: 'origin required' };
  }
  if (!allowed.includes(origin)) return { ok: false, reason: 'origin not allowed' };
  return { ok: true };
}

export function readHeaderOrigin(headers: unknown): string | undefined {
  if (typeof headers !== 'object' || headers === null || !('origin' in headers)) return undefined;
  const value = headers.origin;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}
