import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import type { ChargeRequest, CreatedCharge, PaymentProvider, WebhookCheck } from './provider.js';

/** Well-known sandbox key. It is not a live credential and is not stored in the database. */
export const SANDBOX_WEBHOOK_KEY = 'k2-sandbox-webhook';

export function signSandboxWebhook(payload: string): string {
  return createHmac('sha256', SANDBOX_WEBHOOK_KEY).update(payload).digest('hex');
}

export class SandboxPaymentProvider implements PaymentProvider {
  createCharge(request: ChargeRequest): Promise<CreatedCharge> {
    if (request.metadata.simulate === 'fail') {
      return Promise.resolve({ providerRef: `sandbox_fail_${randomUUID()}` });
    }
    return Promise.resolve({ providerRef: `sandbox_${randomUUID()}` });
  }

  verifyWebhook(payload: string, signature: string): WebhookCheck {
    const expected = signSandboxWebhook(payload);
    const left = Buffer.from(expected);
    const right = Buffer.from(signature);
    if (left.length !== right.length || !timingSafeEqual(left, right)) return { ok: false };
    return { ok: true, body: payload };
  }

  refund(): Promise<never> {
    return Promise.reject(new Error('Refunds are not implemented'));
  }
}
