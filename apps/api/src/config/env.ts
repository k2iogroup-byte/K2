export type AppEnv = 'development' | 'staging' | 'production';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
export type DatabaseSslMode = 'disable' | 'no-verify' | 'verify';

export type AppConfig = {
  appEnv: AppEnv;
  host: string;
  port: number;
  logLevel: LogLevel;
  serviceName: string;
  serviceVersion: string;
  databaseUrl: string;
  databasePoolMax: number;
  databaseSsl: DatabaseSslMode;
  corsOrigins: readonly string[];
};

export type ConfigIssue = {
  path: string;
  message: string;
};

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(
      `Invalid configuration: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const APP_ENVS = ['development', 'staging', 'production'] as const;
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
const SSL_MODES = ['disable', 'no-verify', 'verify'] as const;

const FORBIDDEN_PASSWORDS = new Set([
  'replace_with_local_password',
  'password',
  'changeme',
  'secret',
  'postgres',
  'k2',
]);

const NON_DEV_PASSWORDS = new Set(['k2_ci_test_password']);
const MIN_PASSWORD_LENGTH = 12;
const PRIVATE_HOST_SUFFIXES = ['.railway.internal', '.internal'];

type Env = Record<string, string | undefined>;

type ParsedDatabase = {
  url: URL;
  raw: string;
};

export function loadConfig(env: Env): AppConfig {
  const issues: ConfigIssue[] = [];
  const appEnv = readEnum(
    env.APP_ENV,
    APP_ENVS,
    'APP_ENV',
    'must be development, staging, or production',
    issues,
  );
  const logLevel = readEnum(
    env.LOG_LEVEL === undefined || env.LOG_LEVEL === '' ? 'info' : env.LOG_LEVEL,
    LOG_LEVELS,
    'LOG_LEVEL',
    'must be fatal, error, warn, info, debug, or trace',
    issues,
  );
  const databaseSsl = readEnum(
    env.DATABASE_SSL,
    SSL_MODES,
    'DATABASE_SSL',
    'must be disable, no-verify, or verify',
    issues,
  );
  const host = readHost(env.HOST, appEnv, issues);
  const port = readPort(env.PORT, appEnv, issues);
  const serviceName = readToken(env.SERVICE_NAME, 'k2-api', 'SERVICE_NAME', issues);
  const serviceVersion = readVersion(env.SERVICE_VERSION, issues);
  const databasePoolMax = readPoolMax(env.DATABASE_POOL_MAX, issues);
  const database = readDatabaseUrl(env.DATABASE_URL, issues);
  const corsOrigins = readCors(env.CORS_ORIGINS, appEnv, issues);

  if (appEnv && database && databaseSsl) {
    checkDatabasePolicy(appEnv, database.url, databaseSsl, issues);
  }

  if (
    issues.length > 0 ||
    !appEnv ||
    !logLevel ||
    !databaseSsl ||
    host === undefined ||
    port === undefined ||
    !serviceName ||
    !serviceVersion ||
    databasePoolMax === undefined ||
    !database ||
    !corsOrigins
  ) {
    throw new ConfigError(issues.length > 0 ? issues : [{ path: 'config', message: 'is invalid' }]);
  }

  return {
    appEnv,
    host,
    port,
    logLevel,
    serviceName,
    serviceVersion,
    databaseUrl: database.raw,
    databasePoolMax,
    databaseSsl,
    corsOrigins,
  };
}

function readEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  path: string,
  message: string,
  issues: ConfigIssue[],
): T | null {
  if (raw === undefined || raw === '') {
    issues.push({ path, message: 'is required' });
    return null;
  }
  if (!(allowed as readonly string[]).includes(raw)) {
    issues.push({ path, message });
    return null;
  }
  return raw as T;
}

function readHost(
  raw: string | undefined,
  appEnv: AppEnv | null,
  issues: ConfigIssue[],
): string | undefined {
  const value =
    raw === undefined || raw === ''
      ? appEnv === 'staging' || appEnv === 'production'
        ? '0.0.0.0'
        : '127.0.0.1'
      : raw.trim();
  if (value.length === 0 || value.length > 255 || /\s/.test(value)) {
    issues.push({ path: 'HOST', message: 'must be a hostname or IP address' });
    return undefined;
  }
  return value;
}

function readPort(
  raw: string | undefined,
  appEnv: AppEnv | null,
  issues: ConfigIssue[],
): number | undefined {
  const value = raw === undefined || raw === '' ? '4000' : raw.trim();
  if (!/^\d+$/.test(value)) {
    issues.push({ path: 'PORT', message: 'must be an integer from 0 to 65535' });
    return undefined;
  }
  const port = Number(value);
  if (port > 65535) {
    issues.push({ path: 'PORT', message: 'must be an integer from 0 to 65535' });
    return undefined;
  }
  if (port === 0 && appEnv !== 'development') {
    issues.push({ path: 'PORT', message: 'must be a non-zero port outside development' });
    return undefined;
  }
  return port;
}

function readToken(
  raw: string | undefined,
  fallback: string,
  path: string,
  issues: ConfigIssue[],
): string | null {
  const value = raw === undefined || raw === '' ? fallback : raw;
  if (!/^[a-z0-9-]{1,40}$/.test(value)) {
    issues.push({
      path,
      message: 'must be 1-40 characters of lowercase letters, digits, or hyphens',
    });
    return null;
  }
  return value;
}

function readVersion(raw: string | undefined, issues: ConfigIssue[]): string | null {
  const value = raw === undefined || raw === '' ? '0.1.0' : raw;
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(value)) {
    issues.push({ path: 'SERVICE_VERSION', message: 'must be 1-32 characters without spaces' });
    return null;
  }
  return value;
}

function readPoolMax(raw: string | undefined, issues: ConfigIssue[]): number | undefined {
  const value = raw === undefined || raw === '' ? '10' : raw.trim();
  if (!/^\d+$/.test(value)) {
    issues.push({ path: 'DATABASE_POOL_MAX', message: 'must be an integer from 1 to 20' });
    return undefined;
  }
  const parsed = Number(value);
  if (parsed < 1 || parsed > 20) {
    issues.push({ path: 'DATABASE_POOL_MAX', message: 'must be an integer from 1 to 20' });
    return undefined;
  }
  return parsed;
}

function readDatabaseUrl(raw: string | undefined, issues: ConfigIssue[]): ParsedDatabase | null {
  if (raw === undefined || raw === '') {
    issues.push({ path: 'DATABASE_URL', message: 'is required' });
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    issues.push({ path: 'DATABASE_URL', message: 'must be a PostgreSQL connection URL' });
    return null;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    issues.push({ path: 'DATABASE_URL', message: 'must be a PostgreSQL connection URL' });
    return null;
  }
  const database = url.pathname.replace(/^\//, '');
  if (url.username === '' || url.password === '' || database === '' || database.includes('/')) {
    issues.push({
      path: 'DATABASE_URL',
      message: 'must include a username, password, and database name',
    });
    return null;
  }
  let password: string;
  try {
    password = decodeURIComponent(url.password);
  } catch {
    issues.push({ path: 'DATABASE_URL', message: 'password encoding is invalid' });
    return null;
  }
  const normalized = password.toLowerCase();
  if (
    password.length < MIN_PASSWORD_LENGTH ||
    FORBIDDEN_PASSWORDS.has(normalized) ||
    normalized.includes('replace_with')
  ) {
    issues.push({ path: 'DATABASE_URL', message: 'password does not meet the baseline' });
    return null;
  }
  return { url, raw };
}

function checkDatabasePolicy(
  appEnv: AppEnv,
  url: URL,
  ssl: DatabaseSslMode,
  issues: ConfigIssue[],
): void {
  const host = url.hostname.toLowerCase();
  let password: string;
  try {
    password = decodeURIComponent(url.password);
  } catch {
    password = url.password;
  }
  if (appEnv !== 'development' && NON_DEV_PASSWORDS.has(password.toLowerCase())) {
    issues.push({ path: 'DATABASE_URL', message: 'password is a known non-production fixture' });
  }
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (appEnv !== 'development' && local) {
    issues.push({
      path: 'DATABASE_URL',
      message: 'must not point at localhost outside development',
    });
  }
  const privateHost = PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (appEnv !== 'development' && ssl === 'disable' && !privateHost) {
    issues.push({
      path: 'DATABASE_SSL',
      message: 'must be no-verify or verify for public database hosts',
    });
  }
}

function readCors(
  raw: string | undefined,
  appEnv: AppEnv | null,
  issues: ConfigIssue[],
): string[] | null {
  if (raw === undefined || raw.trim() === '') {
    issues.push({ path: 'CORS_ORIGINS', message: 'is required' });
    return null;
  }
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) {
    issues.push({ path: 'CORS_ORIGINS', message: 'must list at least one origin' });
    return null;
  }
  if (parts.includes('*')) {
    issues.push({ path: 'CORS_ORIGINS', message: 'must not contain a wildcard' });
    return null;
  }
  const origins: string[] = [];
  for (const part of parts) {
    let url: URL;
    try {
      url = new URL(part);
    } catch {
      issues.push({ path: 'CORS_ORIGINS', message: 'must contain valid http(s) origins' });
      return null;
    }
    const hasCredentials = url.username !== '' || url.password !== '';
    const hasExtra =
      url.search !== '' || url.hash !== '' || (url.pathname !== '/' && url.pathname !== '');
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || hasCredentials || hasExtra) {
      issues.push({
        path: 'CORS_ORIGINS',
        message: 'must be scheme, host, and optional port only',
      });
      return null;
    }
    origins.push(url.origin);
  }
  if (
    appEnv !== null &&
    appEnv !== 'development' &&
    origins.some((origin) => origin.startsWith('http://'))
  ) {
    issues.push({ path: 'CORS_ORIGINS', message: 'must use https outside development' });
    return null;
  }
  return [...new Set(origins)];
}
