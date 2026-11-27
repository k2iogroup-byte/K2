import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import type { KycProvider, KycWebhookCheck } from './provider.js';

/** Well-known sandbox key. It is not a live credential and is not stored in the database. */
export const SANDBOX_KYC_KEY = 'k2-sandbox-kyc';

export function signSandboxKyc(payload: string): string {
  return createHmac('sha256', SANDBOX_KYC_KEY).update(payload).digest('hex');
}

export class SandboxKycProvider implements KycProvider {
  submitDocuments(): Promise<{ providerRef: string }> {
    return Promise.resolve({ providerRef: `kyc_${randomUUID()}` });
  }

  verifyWebhook(payload: string, signature: string): KycWebhookCheck {
    const expected = signSandboxKyc(payload);
    const left = Buffer.from(expected);
    const right = Buffer.from(signature);
    if (left.length !== right.length || !timingSafeEqual(left, right)) return { ok: false };
    return { ok: true, body: payload };
  }
}
