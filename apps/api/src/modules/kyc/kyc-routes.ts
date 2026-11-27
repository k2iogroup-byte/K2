import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';

import { AppError } from '../../infrastructure/http/errors.js';
import { parseWithSchema } from '../../infrastructure/http/validation.js';
import type { AuthService } from '../auth/auth-service.js';
import { requireVerifiedEmail } from '../auth/rbac.js';
import { noStore, requireRead, requireWrite, sendJson } from '../auth/request-context.js';
import {
  applyKycWebhook,
  checkStatus,
  decideKyc,
  KycRejected,
  submitDocuments,
} from './kyc-service.js';

const documentsBody = z.strictObject({
  documentIds: z.array(z.string().min(1).max(80)).min(1).max(10),
});
const webhookBody = z.strictObject({
  payload: z.string().min(1).max(4000),
  signature: z.string().min(1).max(128),
});
const decisionBody = z.strictObject({
  userId: z.uuid(),
  decision: z.enum(['VERIFIED', 'REJECTED']),
  reason: z.string().max(500),
});

export function registerKycRoutes(app: FastifyInstance, auth: AuthService, pool: Pool): void {
  app.post('/kyc/documents', async (request, reply) => {
    noStore(reply);
    const session = await requireWrite(auth, request);
    requireVerifiedEmail(session);
    const body = parseWithSchema(documentsBody, request.body);
    try {
      const result = await submitDocuments(pool, session.userId, body.documentIds);
      return await sendJson(reply, 201, z.strictObject({ status: z.literal('PENDING') }), result);
    } catch (error) {
      if (error instanceof KycRejected) throw new AppError('VALIDATION_ERROR', 400, error.reason);
      throw error;
    }
  });

  app.get('/kyc/status', async (request, reply) => {
    noStore(reply);
    const session = await requireRead(auth, request);
    const status = await checkStatus(pool, session.userId);
    return await sendJson(reply, 200, z.strictObject({ status: z.string() }), { status });
  });

  app.post('/kyc/webhook', async (request, reply) => {
    noStore(reply);
    const body = parseWithSchema(webhookBody, request.body);
    const result = await applyKycWebhook(pool, body.payload, body.signature);
    if (result === 'rejected') throw new AppError('VALIDATION_ERROR', 400, 'REJECTED');
    return await sendJson(reply, 200, z.strictObject({ status: z.literal('accepted') }), {
      status: 'accepted',
    });
  });

  app.post('/kyc/decisions', async (request, reply) => {
    noStore(reply);
    const session = await requireWrite(auth, request);
    const body = parseWithSchema(decisionBody, request.body);
    try {
      await decideKyc(pool, body.userId, session.userId, body.decision, body.reason);
      return await sendJson(
        reply,
        200,
        z.strictObject({ status: z.enum(['VERIFIED', 'REJECTED']) }),
        {
          status: body.decision,
        },
      );
    } catch (error) {
      if (error instanceof KycRejected) throw new AppError('VALIDATION_ERROR', 400, error.reason);
      throw error;
    }
  });
}
