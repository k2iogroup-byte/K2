import { healthResponseSchema } from '@k2/shared';
import { emptyQuerySchema } from '@k2/shared';
import type { FastifyInstance } from 'fastify';

import type { AppConfig } from '../../config/env.js';
import type { DatabaseProbe } from '../../infrastructure/db/probe.js';
import { parseWithSchema } from '../../infrastructure/http/validation.js';

export type TradingLockStatus = 'held' | 'unavailable' | 'lost' | 'not_required';

export type HealthRouteOptions = {
  config: Pick<AppConfig, 'serviceName' | 'serviceVersion' | 'appEnv'>;
  database: DatabaseProbe;
  tradingLockStatus?: () => TradingLockStatus;
};

export function registerHealthRoutes(app: FastifyInstance, options: HealthRouteOptions): void {
  app.get('/health', async (request, reply) => {
    parseWithSchema(emptyQuerySchema, request.query);
    let check;
    try {
      check = await options.database.check();
    } catch {
      check = { reachable: false, migrated: false, latencyMs: 0, schemaVersion: null };
    }
    const tradingLock = options.tradingLockStatus?.() ?? 'not_required';
    // A standby replica is waiting for the singleton. It is healthy for the
    // deploy check and it does not trade. A lost lock is not healthy.
    const lockReady = tradingLock !== 'lost';
    const ready = check.reachable && check.migrated && lockReady;
    const body = {
      status: ready ? 'ok' : 'degraded',
      service: options.config.serviceName,
      version: options.config.serviceVersion,
      environment: options.config.appEnv,
      checks: {
        database: {
          status: check.reachable ? 'up' : 'down',
          latencyMs: check.latencyMs,
          schemaVersion: check.schemaVersion,
        },
        tradingLock: { status: tradingLock },
      },
      timestamp: new Date().toISOString(),
    };
    const parsed = healthResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error('Health response failed contract validation');
    }
    reply.header('cache-control', 'no-store');
    return reply.status(ready ? 200 : 503).send(parsed.data);
  });
}
