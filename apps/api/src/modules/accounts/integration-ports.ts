import { z } from 'zod';

import { AppError } from '../../infrastructure/http/errors.js';

const moneySchema = z.string().regex(/^(?:0|[1-9]\d{0,14})\.\d{2}$/);

/**
 * The only purchase input M-03 accepts. M-08 must verify the provider event
 * before constructing this value. M-03 does not talk to a payment provider.
 */
export const verifiedPurchaseEvidenceSchema = z.strictObject({
  sourceSystem: z.literal('M-08'),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/),
  externalReference: z.string().trim().min(1).max(200),
  userId: z.uuid(),
  priceVersionId: z.uuid(),
  amount: moneySchema,
  currency: z.literal('USD'),
  verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/),
});

export type VerifiedPurchaseEvidence = z.infer<typeof verifiedPurchaseEvidenceSchema>;

/** Posted by M-07. M-03 does not implement this and does not store a balance. */
export type ChallengeFeePosting = {
  accountId: string;
  purchaseEvidenceId: string;
  priceVersionId: string;
  amount: string;
  currency: 'USD';
};

export function postChallengeFee(posting: ChallengeFeePosting): never {
  throw new AppError(
    'DEPENDENCY_UNAVAILABLE',
    409,
    `The financial ledger is not available for ${posting.currency} challenge fees`,
  );
}

export function collectSubscription(): never {
  throw new AppError('DEPENDENCY_UNAVAILABLE', 409, 'Subscription billing is not available');
}
