const MAX_QUERY_LENGTH = 2_048;
const PATH_SEGMENT = /^[a-z0-9_-]+$/i;
const QUERY_BODY = /^[A-Za-z0-9._~%!$&'()*+,;=:@/-]*$/;

/**
 * Forwards one allowlisted path to the configured API origin.
 * Path segments stay restricted to the existing character set, which rejects
 * traversal and an open proxy. A query string is forwarded unchanged when it
 * is short, well formed, and does not smuggle a parent-directory sequence.
 */
export function proxyTarget(
  path: readonly string[],
  search: string,
  destination: string,
): string | null {
  if (!isSafePath(path) || !isSafeSearch(search)) return null;
  const origin = readProxyOrigin(destination);
  if (!origin) return null;
  return `${origin}/${path.join('/')}${search}`;
}

function isSafePath(path: readonly string[]): boolean {
  return path.length > 0 && path.every((segment) => PATH_SEGMENT.test(segment));
}

function isSafeSearch(search: string): boolean {
  if (search === '') return true;
  if (!search.startsWith('?') || search.length > MAX_QUERY_LENGTH) return false;
  const body = search.slice(1);
  if (!QUERY_BODY.test(body)) return false;
  if (body.includes('..') || /%2e%2e/i.test(body)) return false;
  return percentEncodingIsWellFormed(body);
}

function percentEncodingIsWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '%') continue;
    const hex = value.slice(index + 1, index + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return false;
    const code = Number.parseInt(hex, 16);
    if (code <= 0x1f || code === 0x7f) return false;
    index += 2;
  }
  return true;
}

function readProxyOrigin(destination: string): string | null {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  return url.origin;
}
