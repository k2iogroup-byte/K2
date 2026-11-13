import { defineRailway, github, postgres, preserve, project, service } from 'railway/iac';

/**
 * Staging-only Railway definition. This file is not applied by CI.
 * `railway config plan` / `railway config apply` must be run by an owner
 * against an environment named "staging". Production is refused.
 * See docs/DEPLOYMENT_GUIDE.md.
 */
export default defineRailway((ctx) => {
  if (!ctx.isEnvironment('staging')) {
    throw new Error(
      'Module 01 infrastructure applies only to a Railway environment named "staging".',
    );
  }

  const database = postgres('postgres');
  const source = github('k2iogroup-byte/K2', {
    branch: 'main',
    checkSuites: true,
  });

  const api = service('api', {
    source,
    build: 'npm run build -w @k2/shared && npm run build -w @k2/api',
    preDeploy: 'npm run db:migrate -w @k2/api',
    start: 'npm run start -w @k2/api',
    healthcheck: '/health',
    healthcheckTimeout: 120,
    deploy: {
      preDeployTimeoutSeconds: 120,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 5,
      numReplicas: 1,
    },
    env: {
      APP_ENV: 'staging',
      HOST: '0.0.0.0',
      LOG_LEVEL: 'info',
      SERVICE_NAME: 'k2-api',
      SERVICE_VERSION: '0.1.0',
      DATABASE_URL: database.env.DATABASE_URL,
      DATABASE_SSL: 'disable',
      DATABASE_POOL_MAX: '10',
      NODE_ENV: 'production',
      MARKET_DATA_MODE: 'disconnected',
      // One Railway edge hop. Never set this to the string "true".
      TRUST_PROXY: '1',
      CORS_ORIGINS: preserve(),
      WEB_ORIGIN: preserve(),
      MFA_ENCRYPTION_KEY: preserve(),
      EMAIL_DELIVERY: preserve(),
    },
  });

  return project('k2-group', {
    resources: [database, api],
  });
});
