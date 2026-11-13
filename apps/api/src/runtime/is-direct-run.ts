import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function isDirectRun(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === moduleUrl;
  } catch {
    return false;
  }
}
