export type AuthResult = {
  status: number;
  body: unknown;
};

function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  const found = document.cookie.split('; ').find((item) => item.startsWith(prefix));
  if (!found) return null;
  return decodeURIComponent(found.slice(prefix.length));
}

export async function authFetch(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<AuthResult> {
  const method = init?.method ?? 'GET';
  const headers = new Headers({ accept: 'application/json' });
  if (method !== 'GET' && method !== 'HEAD') headers.set('x-k2-request', '1');
  if (init?.body !== undefined) headers.set('content-type', 'application/json');
  const csrf = readCookie('k2_csrf');
  if (csrf && method !== 'GET' && method !== 'HEAD') headers.set('x-csrf-token', csrf);
  const response = await fetch(`/k2-api${path}`, {
    method,
    headers,
    credentials: 'include',
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  if (text === '') return { status: response.status, body: null };
  try {
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    return { status: response.status, body: null };
  }
}

export function errorMessage(body: unknown, fallback: string): string {
  if (typeof body !== 'object' || body === null || !('error' in body)) return fallback;
  const error = body.error;
  if (typeof error !== 'object' || error === null || !('message' in error)) return fallback;
  return typeof error.message === 'string' ? error.message : fallback;
}

export function readHashToken(): string {
  const token = window.location.hash.replace(/^#/, '');
  window.history.replaceState(null, '', window.location.pathname);
  return token;
}
