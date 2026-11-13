export function isAllowedOrigin(origin: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined || origin === '') return true;
  return allowed.includes(origin);
}
