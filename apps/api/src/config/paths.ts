import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function apiPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    if (
      existsSync(path.join(dir, 'package.json')) &&
      existsSync(path.join(dir, 'db', 'migrations'))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('Could not locate the API package root');
}

export function migrationsDirectory(): string {
  return path.join(apiPackageRoot(), 'db', 'migrations');
}

export function resolveEnvFile(): string | undefined {
  const root = apiPackageRoot();
  const local = path.join(root, '.env');
  if (existsSync(local)) return local;
  const repoEnv = path.resolve(root, '..', '..', '.env');
  if (existsSync(repoEnv)) return repoEnv;
  return undefined;
}
