import { existsSync, readFileSync } from 'node:fs';

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Loads KEY=VALUE lines into process.env.
 * Existing variables win, so a hosting platform or test runner cannot be overridden by a file.
 */
export function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const equals = stripped.indexOf('=');
    if (equals <= 0) continue;
    const key = stripped.slice(0, equals).trim();
    if (!KEY.test(key) || process.env[key] !== undefined) continue;
    let value = stripped.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
