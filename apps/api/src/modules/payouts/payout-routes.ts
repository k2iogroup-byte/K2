import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';

import { AppError } from '../../infrastructure/http/errors.js';
import { parseWithSchema } from '../../infrastructure/http/validation.js';
import type { AuthService } from '../auth/auth-service.js';
import { requireVerifiedEmail } from '../auth/rbac.js';
import { noStore, requireRead, requireWrite, sendJson } from '../auth/request-context.js';
import { payoutDashboard, PayoutRejected, requestPayout, reviewQueue } from './requests.js';
import { approvePayout, rejectPayout } from './review.js';

const requestBody = z.strictObject({ accountId: z.uuid() });
const rejectBody = z.strictObject({ reason: z.string().max(500) });
const idParams = z.strictObject({ id: z.uuid() });
const dashboardQuery = z.strictObject({ accountId: z.uuid() });

export function registerPayoutRoutes(app: FastifyInstance, auth: AuthService, pool: Pool): void {
  app.post('/payouts', async (request, reply) => {
    noStore(reply);
    const session = await requireWrite(auth, request);
    requireVerifiedEmail(session);
    const body = parseWithSchema(requestBody, request.body);
    try {
      const created = await requestPayout(pool, body.accountId);
      return await sendJson(
        reply,
        201,
        z.strictObject({
          requestId: z.uuid(),
          status: z.literal('PENDING'),
          traderAmount: z.string(),
        }),
        created,
      );
    } catch (error) {
      if (error instanceof PayoutRejected) {
        throw new AppError('VALIDATION_ERROR', 400, error.reason);
      }
      throw error;
    }
  });

  app.get('/payouts/review', async (request, reply) => {
    noStore(reply);
    await requireRead(auth, request);
    const rows = await reviewQueue(pool);
    return await sendJson(
      reply,
      200,
      z.strictObject({
        items: z.array(z.strictObject({ requestId: z.uuid(), accountId: z.uuid() })),
      }),
      { items: rows },
    );
  });

  app.post('/payouts/:id/approve', async (request, reply) => {
    noStore(reply);
    const session = await requireWrite(auth, request);
    const params = parseWithSchema(idParams, request.params);
    try {
      const paid = await approvePayout(pool, params.id, session.userId);
      return await sendJson(
        reply,
        200,
        z.strictObject({
          accountId: z.uuid(),
          amount: z.string(),
        }),
        paid,
      );
    } catch (error) {
      if (error instanceof PayoutRejected) {
        throw new AppError('VALIDATION_ERROR', 400, error.reason);
      }
      throw error;
    }
  });

  app.post('/payouts/:id/reject', async (request, reply) => {
    noStore(reply);
    const session = await requireWrite(auth, request);
    const params = parseWithSchema(idParams, request.params);
    const body = parseWithSchema(rejectBody, request.body);
    try {
      await rejectPayout(pool, params.id, session.userId, body.reason);
      return await sendJson(reply, 200, z.strictObject({ status: z.literal('REJECTED') }), {
        status: 'REJECTED',
      });
    } catch (error) {
      if (error instanceof PayoutRejected) {
        throw new AppError('VALIDATION_ERROR', 400, error.reason);
      }
      throw error;
    }
  });

  app.get('/payouts/dashboard', async (request, reply) => {
    noStore(reply);
    await requireRead(auth, request);
    const query = parseWithSchema(dashboardQuery, request.query);
    const view = await payoutDashboard(pool, query.accountId);
    return await sendJson(
      reply,
      200,
      z.strictObject({
        eligible: z.boolean(),
        reason: z.string().nullable(),
        nextPayoutAt: z.string().nullable(),
        history: z.array(
          z.strictObject({
            id: z.uuid(),
            status: z.string(),
            traderAmount: z.string(),
            createdAt: z.string(),
          }),
        ),
      }),
      view,
    );
  });
}
