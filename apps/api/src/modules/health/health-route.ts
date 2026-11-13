import { healthResponseSchema } from '@k2/shared';
import { emptyQuerySchema } from '@k2/shared';
import type { FastifyInstance } from 'fastify';

import type { AppConfig } from '../../config/env.js';
import type { DatabaseProbe } from '../../infrastructure/db/probe.js';
import { parseWithSchema } from '../../infrastructure/http/validation.js';

export type HealthRouteOptions = {
  config: Pick<AppConfig, 'serviceName' | 'serviceVersion' | 'appEnv'>;
  database: DatabaseProbe;
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
    const ready = check.reachable && check.migrated;
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
