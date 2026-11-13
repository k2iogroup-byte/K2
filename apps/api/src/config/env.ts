export type AppEnv = 'development' | 'staging' | 'production';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
export type DatabaseSslMode = 'disable' | 'no-verify' | 'verify';

export type EmailDeliveryMode = 'capture' | 'unconfigured' | 'smtp';

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  user: string | null;
  password: string | null;
};

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
  mfaEncryptionKey: Buffer;
  emailDelivery: EmailDeliveryMode;
  smtp: SmtpConfig | null;
  webOrigin: string;
  loginDelayBaseMs: number;
  loginDelayCapMs: number;
  emailOutboxPath: string | null;
};

/** 32 bytes of 0x01. Development only. Rejected in staging and production. */
export const DEVELOPMENT_MFA_KEY = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';

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
  const mfaEncryptionKey = readMfaKey(env.MFA_ENCRYPTION_KEY, appEnv, issues);
  const emailDelivery = readEmailDelivery(env, appEnv, issues);
  const smtp = emailDelivery === null ? null : readSmtp(env, emailDelivery.mode, issues);
  const webOrigin =
    corsOrigins === null ? null : readWebOrigin(env.WEB_ORIGIN, corsOrigins, issues);
  const loginDelay = readLoginDelay(env, appEnv, issues);
  const emailOutboxPath =
    emailDelivery === null
      ? null
      : readOutboxPath(env.EMAIL_OUTBOX_PATH, emailDelivery.mode, issues);

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
    !corsOrigins ||
    !mfaEncryptionKey ||
    !emailDelivery ||
    !webOrigin ||
    !loginDelay
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
    mfaEncryptionKey,
    emailDelivery: emailDelivery.mode,
    smtp,
    webOrigin,
    loginDelayBaseMs: loginDelay.baseMs,
    loginDelayCapMs: loginDelay.capMs,
    emailOutboxPath,
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

function readMfaKey(
  raw: string | undefined,
  appEnv: AppEnv | null,
  issues: ConfigIssue[],
): Buffer | null {
  const value = raw === undefined || raw.trim() === '' ? null : raw.trim();
  if (value?.toLowerCase().includes('replace_with')) {
    issues.push({ path: 'MFA_ENCRYPTION_KEY', message: 'must be replaced' });
    return null;
  }
  const selected = value ?? (appEnv === 'development' ? DEVELOPMENT_MFA_KEY : null);
  if (selected === null) {
    issues.push({ path: 'MFA_ENCRYPTION_KEY', message: 'is required' });
    return null;
  }
  if (appEnv !== null && appEnv !== 'development' && selected === DEVELOPMENT_MFA_KEY) {
    issues.push({ path: 'MFA_ENCRYPTION_KEY', message: 'is a development fixture' });
    return null;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(selected)) {
    issues.push({ path: 'MFA_ENCRYPTION_KEY', message: 'must be a 32-byte base64 key' });
    return null;
  }
  const key = Buffer.from(selected, 'base64');
  if (key.length !== 32 || key.toString('base64') !== selected) {
    issues.push({ path: 'MFA_ENCRYPTION_KEY', message: 'must be a 32-byte base64 key' });
    return null;
  }
  return key;
}

function readEmailDelivery(
  env: Env,
  appEnv: AppEnv | null,
  issues: ConfigIssue[],
): { mode: EmailDeliveryMode } | null {
  const raw = env.EMAIL_DELIVERY?.trim() ?? '';
  const mode: EmailDeliveryMode | null =
    raw === ''
      ? appEnv === 'development'
        ? 'capture'
        : null
      : raw === 'capture' || raw === 'unconfigured' || raw === 'smtp'
        ? raw
        : null;
  if (mode === null) {
    issues.push({
      path: 'EMAIL_DELIVERY',
      message: 'must be capture, unconfigured, or smtp',
    });
    return null;
  }
  if (mode === 'capture' && appEnv !== null && appEnv !== 'development') {
    issues.push({ path: 'EMAIL_DELIVERY', message: 'capture is only allowed in development' });
    return null;
  }
  if (raw === '' && appEnv !== null && appEnv !== 'development') {
    issues.push({ path: 'EMAIL_DELIVERY', message: 'is required' });
    return null;
  }
  return { mode };
}

function readSmtp(env: Env, mode: EmailDeliveryMode, issues: ConfigIssue[]): SmtpConfig | null {
  if (mode !== 'smtp') return null;
  const host = env.SMTP_HOST?.trim() ?? '';
  const from = env.SMTP_FROM?.trim() ?? '';
  const portRaw = env.SMTP_PORT?.trim() ?? '';
  const user = env.SMTP_USER?.trim() ?? '';
  const password = env.SMTP_PASSWORD ?? '';
  let port = Number.NaN;
  if (!/^[A-Za-z0-9.-]{1,255}$/.test(host)) {
    issues.push({ path: 'SMTP_HOST', message: 'must be a hostname' });
  }
  if (!/^\d+$/.test(portRaw) || Number(portRaw) < 1 || Number(portRaw) > 65535) {
    issues.push({ path: 'SMTP_PORT', message: 'must be an integer from 1 to 65535' });
  } else {
    port = Number(portRaw);
  }
  if (!/^[^\s@]+@[^\s@]+$/.test(from) || from.length > 320) {
    issues.push({ path: 'SMTP_FROM', message: 'must be an email address' });
  }
  const secure =
    env.SMTP_SECURE === undefined || env.SMTP_SECURE.trim() === ''
      ? port === 465
      : env.SMTP_SECURE.trim() === 'true'
        ? true
        : env.SMTP_SECURE.trim() === 'false'
          ? false
          : null;
  if (secure === null) {
    issues.push({ path: 'SMTP_SECURE', message: 'must be true or false' });
  }
  if ((user === '') !== (password === '')) {
    issues.push({ path: 'SMTP_USER', message: 'must be set together with SMTP_PASSWORD' });
  }
  if (password !== '' && (password.length < 8 || password.toLowerCase().includes('replace_with'))) {
    issues.push({ path: 'SMTP_PASSWORD', message: 'does not meet the baseline' });
  }
  if (
    issues.some((issue) =>
      ['SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD'].includes(
        issue.path,
      ),
    )
  ) {
    return null;
  }
  return {
    host,
    port,
    secure: secure === true,
    from,
    user: user === '' ? null : user,
    password: password === '' ? null : password,
  };
}

function readWebOrigin(
  raw: string | undefined,
  allowed: readonly string[],
  issues: ConfigIssue[],
): string | null {
  const value = raw === undefined || raw.trim() === '' ? (allowed[0] ?? '') : raw.trim();
  let origin: string;
  try {
    origin = new URL(value).origin;
  } catch {
    issues.push({ path: 'WEB_ORIGIN', message: 'must be an http(s) origin' });
    return null;
  }
  if (!allowed.includes(origin) || origin !== value.replace(/\/$/, '')) {
    issues.push({ path: 'WEB_ORIGIN', message: 'must be one of CORS_ORIGINS' });
    return null;
  }
  return origin;
}

function readLoginDelay(
  env: Env,
  appEnv: AppEnv | null,
  issues: ConfigIssue[],
): { baseMs: number; capMs: number } | null {
  const dev = appEnv === 'development' || appEnv === null;
  const base = readDelay(
    env.AUTH_LOGIN_DELAY_BASE_MS,
    dev ? 0 : 250,
    'AUTH_LOGIN_DELAY_BASE_MS',
    issues,
  );
  const cap = readDelay(
    env.AUTH_LOGIN_DELAY_CAP_MS,
    dev ? 0 : 4_000,
    'AUTH_LOGIN_DELAY_CAP_MS',
    issues,
  );
  if (base === null || cap === null) return null;
  if (!dev && (base < 200 || cap < base)) {
    issues.push({
      path: 'AUTH_LOGIN_DELAY_BASE_MS',
      message: 'must be at least 200ms outside development and not above the cap',
    });
    return null;
  }
  return { baseMs: base, capMs: cap };
}

function readDelay(
  raw: string | undefined,
  fallback: number,
  path: string,
  issues: ConfigIssue[],
): number | null {
  const value = raw === undefined || raw.trim() === '' ? String(fallback) : raw.trim();
  if (!/^\d+$/.test(value)) {
    issues.push({ path, message: 'must be an integer number of milliseconds' });
    return null;
  }
  const parsed = Number(value);
  if (parsed > 60_000) {
    issues.push({ path, message: 'must be an integer number of milliseconds' });
    return null;
  }
  return parsed;
}

function readOutboxPath(
  raw: string | undefined,
  mode: EmailDeliveryMode,
  issues: ConfigIssue[],
): string | null {
  const value = raw === undefined || raw.trim() === '' ? null : raw.trim();
  if (value === null) return null;
  if (mode !== 'capture') {
    issues.push({
      path: 'EMAIL_OUTBOX_PATH',
      message: 'is only available when email delivery is capture',
    });
    return null;
  }
  if (value.length > 300 || value.includes('\0') || value.includes('\n')) {
    issues.push({ path: 'EMAIL_OUTBOX_PATH', message: 'must be a file path' });
    return null;
  }
  return value;
}
