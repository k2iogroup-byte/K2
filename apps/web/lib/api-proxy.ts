export function proxyTarget(
  path: readonly string[],
  search: string,
  destination: string,
): string | null {
  if (search !== '') return null;
  if (path.length === 0 || path.some((segment) => !/^[a-z0-9_-]+$/i.test(segment))) return null;
  let origin: string;
  try {
    const url = new URL(destination);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    origin = url.origin;
  } catch {
    return null;
  }
  return `${origin}/${path.join('/')}`;
}
