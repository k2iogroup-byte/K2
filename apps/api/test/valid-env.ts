export function validEnv(
  overrides: Partial<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  const base: Record<string, string | undefined> = {
    APP_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: '4000',
    LOG_LEVEL: 'info',
    SERVICE_NAME: 'k2-api',
    SERVICE_VERSION: '0.1.0',
    DATABASE_URL: 'postgresql://k2:local-dev-password-value@127.0.0.1:5432/k2_dev',
    DATABASE_POOL_MAX: '10',
    DATABASE_SSL: 'disable',
    CORS_ORIGINS: 'http://127.0.0.1:3000',
    ...overrides,
  };
  return Object.fromEntries(Object.entries(base).filter((entry) => entry[1] !== undefined));
}
