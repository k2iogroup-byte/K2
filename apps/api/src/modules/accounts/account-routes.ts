import {
  accountHistoryResponseSchema,
  accountListResponseSchema,
  activationRequestSchema,
  catalogueResponseSchema,
  challengeProductSchema,
  createProductRequestSchema,
  emptyQuerySchema,
  priceVersionRequestSchema,
  publishRuleSetRequestSchema,
  ruleSetResponseSchema,
  staffCatalogueResponseSchema,
  staffTransitionRequestSchema,
  tradingAccountSchema,
  transitionResultSchema,
} from '@k2/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';

import { parseWithSchema } from '../../infrastructure/http/validation.js';
import type { AuthService } from '../auth/auth-service.js';
import {
  PERMISSIONS,
  requirePermission,
  requireStaffAccess,
  requireVerifiedEmail,
} from '../auth/rbac.js';
import { noStore, requireRead, requireWrite, sendJson } from '../auth/request-context.js';
import { AccountRepository } from './account-repository.js';
import { AccountService } from './account-service.js';

const idParamsSchema = z.strictObject({ id: z.uuid() });
const idempotencySchema = z.string().regex(/^[A-Za-z0-9_-]{16,80}$/);
const activationResponseSchema = z.strictObject({
  productId: z.uuid(),
  active: z.boolean(),
});
const priceResponseSchema = z.strictObject({
  priceVersionId: z.uuid(),
  price: z.string().regex(/^(?:0|[1-9]\d{0,14})\.\d{2}$/),
});
const rulePublishResponseSchema = z.strictObject({
  id: z.uuid(),
  versionNumber: z.number().int().positive(),
});

export type AccountRouteOptions = {
  auth: AuthService;
  pool: pg.Pool;
};

export function registerAccountRoutes(app: FastifyInstance, options: AccountRouteOptions): void {
  const service = new AccountService(new AccountRepository(options.pool));

  app.get('/catalogue/challenges', async (request, reply) => {
    noStore(reply);
    parseWithSchema(emptyQuerySchema, request.query);
    return sendJson(reply, 200, catalogueResponseSchema, {
      products: await service.publicCatalogue(),
    });
  });

  app.get('/catalogue/rulesets/current', async (request, reply) => {
    noStore(reply);
    parseWithSchema(emptyQuerySchema, request.query);
    return sendJson(reply, 200, ruleSetResponseSchema, await service.currentRules());
  });

  app.get('/catalogue/rulesets/:id', async (request, reply) => {
    noStore(reply);
    parseWithSchema(emptyQuerySchema, request.query);
    const params = parseWithSchema(idParamsSchema, request.params);
    return sendJson(reply, 200, ruleSetResponseSchema, await service.rules(params.id));
  });

  app.get('/accounts', async (request, reply) => {
    noStore(reply);
    const auth = await requireRead(options.auth, request);
    requirePermission(auth, PERMISSIONS.accountsRead);
    requireVerifiedEmail(auth);
    return sendJson(reply, 200, accountListResponseSchema, {
      accounts: await service.ownAccounts(auth.userId),
    });
  });

  app.get('/accounts/:id', async (request, reply) => {
    noStore(reply);
    const auth = await requireRead(options.auth, request);
    requirePermission(auth, PERMISSIONS.accountsRead);
    requireVerifiedEmail(auth);
    const params = parseWithSchema(idParamsSchema, request.params);
    return sendJson(
      reply,
      200,
      tradingAccountSchema,
      await service.ownAccount(auth.userId, params.id),
    );
  });

  app.get('/accounts/:id/history', async (request, reply) => {
    noStore(reply);
    const auth = await requireRead(options.auth, request);
    requirePermission(auth, PERMISSIONS.accountsRead);
    requireVerifiedEmail(auth);
    const params = parseWithSchema(idParamsSchema, request.params);
    return sendJson(reply, 200, accountHistoryResponseSchema, {
      transitions: await service.ownHistory(auth.userId, params.id),
    });
  });

  app.get('/staff/catalogue/products', async (request, reply) => {
    noStore(reply);
    const auth = await requireRead(options.auth, request);
    requireStaffAccess(auth, PERMISSIONS.catalogueManage);
    return sendJson(reply, 200, staffCatalogueResponseSchema, {
      products: await service.staffCatalogue(),
    });
  });

  app.get('/staff/users/:id/accounts', async (request, reply) => {
    noStore(reply);
    const auth = await requireRead(options.auth, request);
    requireStaffAccess(auth, PERMISSIONS.accountsRead);
    const params = parseWithSchema(idParamsSchema, request.params);
    return sendJson(reply, 200, accountListResponseSchema, {
      accounts: await service.staffAccounts(params.id),
    });
  });

  app.get('/staff/accounts/:id', async (request, reply) => {
    noStore(reply);
    const auth = await requireRead(options.auth, request);
    requireStaffAccess(auth, PERMISSIONS.accountsRead);
    const params = parseWithSchema(idParamsSchema, request.params);
    return sendJson(reply, 200, tradingAccountSchema, await service.staffAccount(params.id));
  });

  app.get('/staff/accounts/:id/history', async (request, reply) => {
    noStore(reply);
    const auth = await requireRead(options.auth, request);
    requireStaffAccess(auth, PERMISSIONS.accountsRead);
    const params = parseWithSchema(idParamsSchema, request.params);
    return sendJson(reply, 200, accountHistoryResponseSchema, {
      transitions: await service.staffHistory(params.id),
    });
  });

  app.post('/staff/catalogue/products', async (request, reply) => {
    noStore(reply);
    const auth = await requireWrite(options.auth, request);
    requireStaffAccess(auth, PERMISSIONS.catalogueManage);
    const body = parseWithSchema(createProductRequestSchema, request.body);
    const created = await service.createProduct(
      actor(auth.userId, request),
      idempotencyKey(request),
      body,
    );
    return sendJson(reply, 201, challengeProductSchema, created);
  });

  app.post('/staff/catalogue/products/:id/activation', async (request, reply) => {
    noStore(reply);
    const auth = await requireWrite(options.auth, request);
    requireStaffAccess(auth, PERMISSIONS.catalogueManage);
    const params = parseWithSchema(idParamsSchema, request.params);
    const body = parseWithSchema(activationRequestSchema, request.body);
    return sendJson(
      reply,
      200,
      activationResponseSchema,
      await service.setActivation(
        actor(auth.userId, request),
        params.id,
        idempotencyKey(request),
        body,
      ),
    );
  });

  app.post('/staff/catalogue/products/:id/prices', async (request, reply) => {
    noStore(reply);
    const auth = await requireWrite(options.auth, request);
    requireStaffAccess(auth, PERMISSIONS.catalogueManage);
    const params = parseWithSchema(idParamsSchema, request.params);
    const body = parseWithSchema(priceVersionRequestSchema, request.body);
    return sendJson(
      reply,
      201,
      priceResponseSchema,
      await service.addPrice(actor(auth.userId, request), params.id, idempotencyKey(request), body),
    );
  });

  app.post('/staff/rulesets', async (request, reply) => {
    noStore(reply);
    const auth = await requireWrite(options.auth, request);
    requireStaffAccess(auth, PERMISSIONS.catalogueManage);
    const body = parseWithSchema(publishRuleSetRequestSchema, request.body);
    return sendJson(
      reply,
      201,
      rulePublishResponseSchema,
      await service.publishRules(actor(auth.userId, request), idempotencyKey(request), body),
    );
  });

  app.post('/staff/accounts/:id/transitions', async (request, reply) => {
    noStore(reply);
    const auth = await requireWrite(options.auth, request);
    requireStaffAccess(auth, PERMISSIONS.accountsTransition);
    const params = parseWithSchema(idParamsSchema, request.params);
    const body = parseWithSchema(staffTransitionRequestSchema, request.body);
    return sendJson(
      reply,
      200,
      transitionResultSchema,
      await service.transition(
        actor(auth.userId, request),
        params.id,
        idempotencyKey(request),
        body,
      ),
    );
  });
}

function actor(
  userId: string,
  request: FastifyRequest,
): { userId: string; requestId: string | null } {
  return { userId, requestId: request.id };
}

function idempotencyKey(request: FastifyRequest): string {
  const header = request.headers['idempotency-key'];
  return parseWithSchema(z.strictObject({ idempotencyKey: idempotencySchema }), {
    idempotencyKey: typeof header === 'string' ? header : undefined,
  }).idempotencyKey;
}
