import { canonicalDecimal } from '@k2/shared';
import type { Pool } from 'pg';

import type { AccountService } from '../accounts/account-service.js';
import type { PaymentProvider } from './provider.js';

export async function createChallengeCharge(
  pool: Pool,
  provider: PaymentProvider,
  input: { userId: string; priceVersionId: string; idempotencyKey: string },
): Promise<{ chargeId: string; providerRef: string; amount: string }> {
  const price = await pool.query<{ price: string }>(
    `SELECT price::text FROM product_price_versions WHERE id = $1`,
    [input.priceVersionId],
  );
  const stored = price.rows[0]?.price;
  if (!stored) throw new Error('price version not found');
  const amount = canonicalDecimal(stored, 4);
  const created = await provider.createCharge({
    amount,
    currency: 'USD',
    metadata: { purpose: 'CHALLENGE_PURCHASE' },
  });
  const row = await pool.query<{ id: string }>(
    `INSERT INTO payment_charges (
       user_id, purpose, amount, currency, provider, provider_ref, price_version_id,
       idempotency_key, actor_type
     ) VALUES ($1, 'CHALLENGE_PURCHASE', $2, 'USD', 'sandbox', $3, $4, $5, 'SYSTEM')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [input.userId, amount, created.providerRef, input.priceVersionId, input.idempotencyKey],
  );
  const chargeId = row.rows[0]?.id;
  if (!chargeId) {
    const existing = await pool.query<{ id: string; provider_ref: string; amount: string }>(
      `SELECT id, provider_ref, amount::text FROM payment_charges WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    );
    const found = existing.rows[0];
    if (!found) throw new Error('challenge charge was not stored');
    return { chargeId: found.id, providerRef: found.provider_ref, amount: found.amount };
  }
  return { chargeId, providerRef: created.providerRef, amount };
}

export function evidenceAmount(price: string): string {
  return canonicalDecimal(price, 2);
}

export async function provisionPaidChallenge(
  accounts: AccountService,
  input: {
    userId: string;
    priceVersionId: string;
    amount: string;
    eventId: string;
    verifiedAt: string;
  },
): Promise<void> {
  await accounts.provisionFromVerifiedPurchase({
    sourceSystem: 'M-08',
    idempotencyKey: input.eventId,
    externalReference: input.eventId,
    userId: input.userId,
    priceVersionId: input.priceVersionId,
    amount: evidenceAmount(input.amount),
    currency: 'USD',
    verifiedAt: input.verifiedAt,
  });
}
