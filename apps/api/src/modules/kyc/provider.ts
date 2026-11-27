export type KycWebhookCheck = { ok: false } | { ok: true; body: string };

export interface KycProvider {
  submitDocuments(documentIds: readonly string[]): Promise<{ providerRef: string }>;
  verifyWebhook(payload: string, signature: string): KycWebhookCheck;
}
