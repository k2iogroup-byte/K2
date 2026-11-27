export type ChargeRequest = {
  amount: string;
  currency: 'USD';
  metadata: Record<string, string>;
};

export type CreatedCharge = {
  providerRef: string;
};

export type WebhookCheck = { ok: true; body: string } | { ok: false };

export interface PaymentProvider {
  createCharge(request: ChargeRequest): Promise<CreatedCharge>;
  verifyWebhook(payload: string, signature: string): WebhookCheck;
  /** Present for a later provider. Refunds are not implemented. */
  refund(providerRef: string): Promise<never>;
}
