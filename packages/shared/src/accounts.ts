import { z } from 'zod';

export const ACCOUNT_LIFECYCLE_STATES = [
  'PROVISIONED',
  'ACTIVE',
  'PASSED',
  'FAILED',
  'EXPIRED',
  'SUSPENDED',
  'UNDER_REVIEW',
  'CLOSED',
] as const;

export const STAFF_TRANSITION_REASON_CODES = [
  'STAFF_SUSPEND',
  'STAFF_REVIEW',
  'STAFF_CLOSE',
  'STAFF_RESUME',
] as const;

export const RULE_PARAMETER_STATUSES = ['CONFIRMED', 'UNRESOLVED'] as const;
export const RULE_STAGES = ['STAGE_1', 'STAGE_2'] as const;

const moneySchema = z.string().regex(/^(?:0|[1-9]\d{0,14})\.\d{2}$/);
const decisionRefSchema = z.string().regex(/^[A-Z][A-Z0-9._:-]{2,63}$/);
const reasonSchema = z
  .string()
  .trim()
  .min(8)
  .max(500)
  .regex(/^[\p{L}\p{N} .,'():/_-]+$/u);

export const challengeProductSchema = z.strictObject({
  id: z.uuid(),
  accountSize: moneySchema,
  currency: z.literal('USD'),
  active: z.boolean(),
  price: moneySchema,
  priceVersionId: z.uuid(),
  priceValidFrom: z.string(),
  decisionRef: decisionRefSchema,
});

export const catalogueResponseSchema = z.strictObject({
  products: z.array(challengeProductSchema),
});

export const staffCatalogueResponseSchema = z.strictObject({
  products: z.array(
    challengeProductSchema.extend({
      prices: z.array(
        z.strictObject({
          id: z.uuid(),
          price: moneySchema,
          currency: z.literal('USD'),
          validFrom: z.string(),
          validTo: z.string().nullable(),
          decisionRef: decisionRefSchema,
        }),
      ),
    }),
  ),
});

export const ruleParameterSchema = z.strictObject({
  parameterKey: z.string().regex(/^[a-z0-9_]+$/),
  status: z.enum(RULE_PARAMETER_STATUSES),
  numericValue: z.string().nullable(),
  unit: z.enum(['PCT', 'DAYS', 'USD', 'RATE']).nullable(),
  referenceId: z.string().min(3).max(64),
});

export const ruleSetResponseSchema = z.strictObject({
  id: z.uuid(),
  code: z.literal('CHALLENGE_EVALUATION'),
  versionNumber: z.number().int().positive(),
  decisionRef: decisionRefSchema,
  publishedAt: z.string(),
  stages: z.array(
    z.strictObject({
      stage: z.enum(RULE_STAGES),
      parameters: z.array(ruleParameterSchema),
    }),
  ),
});

export const tradingAccountSchema = z.strictObject({
  id: z.uuid(),
  userId: z.uuid(),
  accountType: z.literal('CHALLENGE'),
  stage: z.literal('STAGE_1'),
  state: z.enum(ACCOUNT_LIFECYCLE_STATES),
  initialCapital: moneySchema,
  currency: z.literal('USD'),
  productId: z.uuid(),
  priceVersionId: z.uuid(),
  ruleSetVersionId: z.uuid(),
  provisionedAt: z.string(),
  closedAt: z.string().nullable(),
});

export const accountListResponseSchema = z.strictObject({
  accounts: z.array(tradingAccountSchema),
});

export const accountTransitionSchema = z.strictObject({
  id: z.uuid(),
  fromState: z.enum(ACCOUNT_LIFECYCLE_STATES).nullable(),
  toState: z.enum(ACCOUNT_LIFECYCLE_STATES),
  reasonCode: z.string(),
  reason: z.string(),
  actorType: z.enum(['SYSTEM', 'STAFF']),
  actorUserId: z.uuid().nullable(),
  createdAt: z.string(),
});

export const accountHistoryResponseSchema = z.strictObject({
  transitions: z.array(accountTransitionSchema),
});

export const transitionResultSchema = z.strictObject({
  accountId: z.uuid(),
  state: z.enum(ACCOUNT_LIFECYCLE_STATES),
  transitionId: z.uuid(),
});

export const createProductRequestSchema = z.strictObject({
  accountSize: moneySchema,
  price: moneySchema,
  decisionRef: decisionRefSchema,
});

export const activationRequestSchema = z.strictObject({
  active: z.boolean(),
  reason: reasonSchema,
});

export const priceVersionRequestSchema = z.strictObject({
  price: moneySchema,
  decisionRef: decisionRefSchema,
});

export const ruleChangeSchema = z.strictObject({
  stage: z.enum(RULE_STAGES),
  parameterKey: z.string().regex(/^[a-z0-9_]+$/),
  numericValue: z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,4})?$/),
});

export const publishRuleSetRequestSchema = z.strictObject({
  decisionRef: decisionRefSchema,
  changes: z.array(ruleChangeSchema).min(1).max(20),
});

export const staffTransitionRequestSchema = z.strictObject({
  toState: z.enum(ACCOUNT_LIFECYCLE_STATES),
  reasonCode: z.enum(STAFF_TRANSITION_REASON_CODES),
  reason: reasonSchema,
});

export type ChallengeProduct = z.infer<typeof challengeProductSchema>;
export type TradingAccount = z.infer<typeof tradingAccountSchema>;
export type AccountLifecycleState = (typeof ACCOUNT_LIFECYCLE_STATES)[number];
export type StaffTransitionReason = (typeof STAFF_TRANSITION_REASON_CODES)[number];
