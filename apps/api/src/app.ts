import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type pg from 'pg';

import type { AppConfig, TrustProxySetting } from './config/env.js';
import type { DatabaseProbe } from './infrastructure/db/probe.js';
import { installErrorHandling } from './infrastructure/http/errors.js';
import { isAllowedOrigin } from './infrastructure/http/origin.js';
import { resolveRequestId } from './infrastructure/http/request-id.js';
import { loggerOptions } from './infrastructure/logging/logger.js';
import { ConnectionLimiter } from './infrastructure/ws/connection-limits.js';
import { registerWebSocket } from './infrastructure/ws/ws-route.js';
import { registerAccountRoutes } from './modules/accounts/account-routes.js';
import { registerAuthRoutes } from './modules/auth/auth-routes.js';
import { createEmailSender, type EmailSender } from './modules/auth/email.js';
import type { RateLimiter } from './modules/auth/rate-limit.js';
import { registerHealthRoutes } from './modules/health/health-route.js';
import { MarketDataEngine } from './modules/market-data/engine.js';
import { registerMarketDataRoutes } from './modules/market-data/market-data-routes.js';
import { registerMarketDataSocket } from './modules/market-data/market-data-ws.js';
import { createProvider } from './modules/market-data/provider.js';
import { MarketDataStore } from './modules/market-data/store.js';

const BODY_LIMIT_BYTES = 16 * 1024;

export type BuildAppOptions = {
  config: AppConfig;
  database: DatabaseProbe;
  pool?: pg.Pool;
  emailSender?: EmailSender;
  limiter?: RateLimiter;
  sleep?: (ms: number) => Promise<void>;
  logger?: FastifyServerOptions['logger'];
  connections?: ConnectionLimiter;
};

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const connections = options.connections ?? new ConnectionLimiter();
  const app = Fastify({
    logger: options.logger === undefined ? loggerOptions(options.config) : options.logger,
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: 15_000,
    trustProxy: fastifyTrustProxy(options.config.trustProxy),
    requestIdHeader: 'x-request-id',
    genReqId: (request) => resolveRequestId(request.headers['x-request-id']),
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts:
      options.config.appEnv === 'development'
        ? false
        : { maxAge: 15_552_000, includeSubDomains: true },
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, isAllowedOrigin(origin, options.config.corsOrigins));
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-request-id', 'x-k2-request', 'x-csrf-token'],
    credentials: true,
    maxAge: 600,
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  installErrorHandling(app);
  registerHealthRoutes(app, { config: options.config, database: options.database });
  if (options.pool) {
    const auth = registerAuthRoutes(app, {
      config: options.config,
      pool: options.pool,
      emailSender: options.emailSender ?? createEmailSender(options.config),
      limiter: options.limiter,
      sleep: options.sleep,
    });
    registerAccountRoutes(app, { auth, pool: options.pool });
    const store = new MarketDataStore(options.pool);
    const instruments = await store.listInstruments();
    const provider = createProvider(options.config.marketDataMode);
    const engine = new MarketDataEngine(
      {
        providerId: provider?.id ?? 'none',
        priceOrigin: 'TEST_FIXTURE',
        sink: store,
      },
      instruments,
    );
    if (provider) {
      provider.start((event) => {
        void engine.ingest(event).catch(() => {
          app.log.error({ event: 'market_data_ingest_failed' }, 'market data ingest failed');
        });
      });
    }
    registerMarketDataRoutes({ app, auth, pool: options.pool, engine });
    await registerWebSocket(app, options.config, connections);
    registerMarketDataSocket(app, options.config, auth, engine, connections);
    return app;
  }
  await registerWebSocket(app, options.config, connections);
  return app;
}

/**
 * Fastify 5.12 treats a numeric `trustProxy` as "trust nobody" and ignores
 * `X-Forwarded-For`. A hop count is therefore a function. `true` is never passed:
 * that would accept a client-supplied address from any peer.
 */
function fastifyTrustProxy(
  setting: TrustProxySetting,
): false | string[] | ((address: string, hop: number) => boolean) {
  if (setting.mode === 'off') return false;
  if (setting.mode === 'ranges') return [...setting.ranges];
  const hops = setting.hops;
  return (_address, hop) => hop < hops;
}
