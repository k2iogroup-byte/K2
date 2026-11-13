import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type pg from 'pg';

import type { AppConfig } from './config/env.js';
import type { DatabaseProbe } from './infrastructure/db/probe.js';
import { installErrorHandling } from './infrastructure/http/errors.js';
import { isAllowedOrigin } from './infrastructure/http/origin.js';
import { resolveRequestId } from './infrastructure/http/request-id.js';
import { loggerOptions } from './infrastructure/logging/logger.js';
import { registerWebSocket } from './infrastructure/ws/ws-route.js';
import { registerAuthRoutes } from './modules/auth/auth-routes.js';
import { createEmailSender, type EmailSender } from './modules/auth/email.js';
import type { MemoryRateLimiter } from './modules/auth/rate-limit.js';
import { registerHealthRoutes } from './modules/health/health-route.js';

const BODY_LIMIT_BYTES = 16 * 1024;

export type BuildAppOptions = {
  config: AppConfig;
  database: DatabaseProbe;
  pool?: pg.Pool;
  emailSender?: EmailSender;
  limiter?: MemoryRateLimiter;
  sleep?: (ms: number) => Promise<void>;
  logger?: FastifyServerOptions['logger'];
};

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger === undefined ? loggerOptions(options.config) : options.logger,
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: 15_000,
    trustProxy: false,
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
    registerAuthRoutes(app, {
      config: options.config,
      pool: options.pool,
      emailSender: options.emailSender ?? createEmailSender(options.config),
      limiter: options.limiter,
      sleep: options.sleep,
    });
  }
  await registerWebSocket(app, options.config);
  return app;
}
