import { createHash } from 'node:crypto';

import type { AccountLifecycleState, StaffTransitionReason, TradingAccount } from '@k2/shared';
import {
  canonicalDecimal,
  challengeProductSchema,
  DecimalError,
  decimalGreaterThan,
  decimalLessThan,
  decimalsEqual,
} from '@k2/shared';
import type { ZodType } from 'zod';
import { z } from 'zod';

import { AppError } from '../../infrastructure/http/errors.js';
import type {
  AccountRecord,
  AccountRepository,
  ProductRecord,
  RuleParameterRecord,
  RuleSetRecord,
  TransitionRecord,
} from './account-repository.js';
import { UniqueViolation } from './account-repository.js';
import type { VerifiedPurchaseEvidence } from './integration-ports.js';
import { verifiedPurchaseEvidenceSchema } from './integration-ports.js';
import { decideStaffTransition } from './lifecycle.js';

const SKEW_MS = 5 * 60 * 1000;
const REMOVED_SIZES = new Set(['5000.00', '300000.00']);

type Actor = {
  userId: string;
  requestId: string | null;
};

type ProductBody = {
  accountSize: string;
  price: string;
  decisionRef: string;
};

type ActivationBody = {
  active: boolean;
  reason: string;
};

type PriceBody = {
  price: string;
  decisionRef: string;
};

type RuleBody = {
  decisionRef: string;
  changes: readonly { stage: 'STAGE_1' | 'STAGE_2'; parameterKey: string; numericValue: string }[];
};

type TransitionBody = {
  toState: AccountLifecycleState;
  reasonCode: StaffTransitionReason;
  reason: string;
};

export class AccountService {
  constructor(
    private readonly repository: AccountRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async publicCatalogue(): Promise<ReturnType<typeof presentProduct>[]> {
    const products = await this.repository.listPublicProducts();
    return products.map(presentProduct);
  }

  async staffCatalogue(): Promise<
    (ReturnType<typeof presentProduct> & {
      prices: {
        id: string;
        price: string;
        currency: 'USD';
        validFrom: string;
        validTo: string | null;
        decisionRef: string;
      }[];
    })[]
  > {
    const products = await this.repository.listStaffProducts();
    const presented = [];
    for (const product of products) {
      const prices = await this.repository.listPrices(product.id);
      presented.push({
        ...presentProduct(product),
        prices: prices.map((price) => ({
          id: price.id,
          price: money(price.price),
          currency: 'USD' as const,
          validFrom: price.validFrom.toISOString(),
          validTo: price.validTo?.toISOString() ?? null,
          decisionRef: price.decisionRef,
        })),
      });
    }
    return presented;
  }

  async currentRules(): Promise<ReturnType<typeof presentRuleSet>> {
    return presentRuleSet(await this.repository.currentRuleSet());
  }

  async rules(id: string): Promise<ReturnType<typeof presentRuleSet>> {
    const ruleSet = await this.repository.ruleSet(id);
    if (!ruleSet) throw new AppError('NOT_FOUND', 404, 'Not found');
    return presentRuleSet(ruleSet);
  }

  async ownAccounts(userId: string): Promise<TradingAccount[]> {
    const accounts = await this.repository.listAccounts(userId);
    return accounts.map(presentAccount);
  }

  async ownAccount(userId: string, accountId: string): Promise<TradingAccount> {
    const account = await this.repository.getAccount(accountId);
    if (!account || account.userId !== userId) throw new AppError('NOT_FOUND', 404, 'Not found');
    return presentAccount(account);
  }

  async ownHistory(
    userId: string,
    accountId: string,
  ): Promise<ReturnType<typeof presentTransition>[]> {
    await this.ownAccount(userId, accountId);
    const transitions = await this.repository.listTransitions(accountId);
    return transitions.map(presentTransition);
  }

  async staffAccounts(userId: string): Promise<TradingAccount[]> {
    return (await this.repository.listAccounts(userId)).map(presentAccount);
  }

  async staffAccount(accountId: string): Promise<TradingAccount> {
    const account = await this.repository.getAccount(accountId);
    if (!account) throw new AppError('NOT_FOUND', 404, 'Not found');
    return presentAccount(account);
  }

  async staffHistory(accountId: string): Promise<ReturnType<typeof presentTransition>[]> {
    await this.staffAccount(accountId);
    return (await this.repository.listTransitions(accountId)).map(presentTransition);
  }

  async createProduct(
    actor: Actor,
    idempotencyKey: string,
    body: ProductBody,
  ): Promise<ReturnType<typeof presentProduct>> {
    const hash = commandHash('product.create', body);
    const stored = await this.repository.command(idempotencyKey);
    if (stored)
      return readStored(challengeProductSchema, stored.requestHash, hash, stored.response);
    const size = money(body.accountSize);
    const price = money(body.price);
    if (
      REMOVED_SIZES.has(size) ||
      decimalGreaterThan(size, '1000000.00', 2) ||
      decimalsEqual(size, '0.00', 2)
    ) {
      throw new AppError('VALIDATION_ERROR', 400, 'Request validation failed', [
        { path: 'accountSize', message: 'Invalid value' },
      ]);
    }
    if (decimalLessThan(price, '0.01', 2)) {
      throw new AppError('VALIDATION_ERROR', 400, 'Request validation failed', [
        { path: 'price', message: 'Invalid value' },
      ]);
    }
    try {
      return await this.repository.transaction(async (client) => {
        const again = await this.repository.command(idempotencyKey, client);
        if (again)
          return readStored(challengeProductSchema, again.requestHash, hash, again.response);
        const productId = await this.repository.insertProduct(client, size);
        const now = this.clock();
        await this.repository.insertPrice(client, {
          productId,
          price,
          validFrom: now,
          decisionRef: body.decisionRef,
          createdBy: actor.userId,
        });
        await this.repository.insertActivation(client, {
          productId,
          active: true,
          actorUserId: actor.userId,
          reason: 'Product published with its opening price',
          idempotencyKey: `${idempotencyKey}:activation`,
        });
        await this.repository.insertAudit(client, {
          eventType: 'catalogue.product_created',
          actorUserId: actor.userId,
          targetAccountId: null,
          targetProductId: productId,
          requestId: actor.requestId,
          metadata: { decisionRef: body.decisionRef, accountSize: size, price },
        });
        const products = await client.query<{
          id: string;
          account_size: string;
          active: boolean;
          price_version_id: string;
          price: string;
          valid_from: Date;
          decision_ref: string;
        }>(
          `SELECT p.id, p.account_size::text, p.active, v.id AS price_version_id, v.price::text,
                  v.valid_from, v.decision_ref
           FROM challenge_products p
           JOIN product_price_versions v ON v.product_id = p.id AND v.valid_to IS NULL
           WHERE p.id = $1`,
          [productId],
        );
        const row = products.rows[0];
        if (!row) throw new Error('Created product is missing');
        const response = presentProduct({
          id: row.id,
          accountSize: row.account_size,
          currency: 'USD',
          active: row.active,
          priceVersionId: row.price_version_id,
          price: row.price,
          priceValidFrom: row.valid_from,
          decisionRef: row.decision_ref,
        });
        await this.repository.insertCommand(
          client,
          idempotencyKey,
          'product.create',
          hash,
          response,
        );
        return response;
      });
    } catch (error) {
      if (error instanceof UniqueViolation) {
        throw new AppError(
          'CONFLICT',
          409,
          'The catalogue command conflicts with an existing record',
        );
      }
      throw mapConstraint(error);
    }
  }

  async setActivation(
    actor: Actor,
    productId: string,
    idempotencyKey: string,
    body: ActivationBody,
  ): Promise<{ productId: string; active: boolean }> {
    const hash = commandHash('product.activation', { ...body, productId });
    const stored = await this.repository.command(idempotencyKey);
    if (stored)
      return readStored(activationStoredSchema, stored.requestHash, hash, stored.response);
    const response = await this.repository.transaction(async (client) => {
      const again = await this.repository.command(idempotencyKey, client);
      if (again) return readStored(activationStoredSchema, again.requestHash, hash, again.response);
      const product = await this.repository.lockProduct(client, productId);
      if (!product) throw new AppError('NOT_FOUND', 404, 'Not found');
      if (product.active === body.active) {
        throw new AppError('CONFLICT', 409, 'The product is already in that state');
      }
      await this.repository.insertActivation(client, {
        productId,
        active: body.active,
        actorUserId: actor.userId,
        reason: body.reason,
        idempotencyKey,
      });
      await this.repository.insertAudit(client, {
        eventType: body.active ? 'catalogue.product_activated' : 'catalogue.product_deactivated',
        actorUserId: actor.userId,
        targetAccountId: null,
        targetProductId: productId,
        requestId: actor.requestId,
        metadata: { active: body.active },
      });
      const result = { productId, active: body.active };
      await this.repository.insertCommand(
        client,
        idempotencyKey,
        'product.activation',
        hash,
        result,
      );
      return result;
    });
    return response;
  }

  async addPrice(
    actor: Actor,
    productId: string,
    idempotencyKey: string,
    body: PriceBody,
  ): Promise<{ priceVersionId: string; price: string }> {
    const hash = commandHash('product.price', { ...body, productId });
    const stored = await this.repository.command(idempotencyKey);
    if (stored) return readStored(priceStoredSchema, stored.requestHash, hash, stored.response);
    const price = money(body.price);
    return this.repository.transaction(async (client) => {
      const again = await this.repository.command(idempotencyKey, client);
      if (again) return readStored(priceStoredSchema, again.requestHash, hash, again.response);
      const product = await this.repository.lockProduct(client, productId);
      if (!product) throw new AppError('NOT_FOUND', 404, 'Not found');
      const now = this.clock();
      const previous = await this.repository.closeOpenPrice(client, productId, now);
      if (decimalsEqual(previous, price, 4)) {
        throw new AppError('CONFLICT', 409, 'The price version matches the current price');
      }
      const priceVersionId = await this.repository.insertPrice(client, {
        productId,
        price,
        validFrom: now,
        decisionRef: body.decisionRef,
        createdBy: actor.userId,
      });
      await this.repository.insertAudit(client, {
        eventType: 'catalogue.price_versioned',
        actorUserId: actor.userId,
        targetAccountId: null,
        targetProductId: productId,
        requestId: actor.requestId,
        metadata: { priceVersionId, price, decisionRef: body.decisionRef },
      });
      const result = { priceVersionId, price };
      await this.repository.insertCommand(client, idempotencyKey, 'product.price', hash, result);
      return result;
    });
  }

  async publishRules(
    actor: Actor,
    idempotencyKey: string,
    body: RuleBody,
  ): Promise<{ id: string; versionNumber: number }> {
    const hash = commandHash('ruleset.publish', body);
    const stored = await this.repository.command(idempotencyKey);
    if (stored) return readStored(ruleStoredSchema, stored.requestHash, hash, stored.response);
    return this.repository.transaction(async (client) => {
      const again = await this.repository.command(idempotencyKey, client);
      if (again) return readStored(ruleStoredSchema, again.requestHash, hash, again.response);
      const current = await this.repository.lockRuleParameters(client);
      const next = applyRuleChanges(current.parameters, body.changes);
      const id = await this.repository.insertRuleVersion(client, {
        versionNumber: current.versionNumber + 1,
        decisionRef: body.decisionRef,
        createdBy: actor.userId,
        parameters: next,
      });
      await this.repository.insertAudit(client, {
        eventType: 'ruleset.version_published',
        actorUserId: actor.userId,
        targetAccountId: null,
        targetProductId: null,
        requestId: actor.requestId,
        metadata: { ruleSetVersionId: id, decisionRef: body.decisionRef },
      });
      const result = { id, versionNumber: current.versionNumber + 1 };
      await this.repository.insertCommand(client, idempotencyKey, 'ruleset.publish', hash, result);
      return result;
    });
  }

  async transition(
    actor: Actor,
    accountId: string,
    idempotencyKey: string,
    body: TransitionBody,
  ): Promise<{ accountId: string; state: AccountLifecycleState; transitionId: string }> {
    const existing = await this.repository.transitionByKey(idempotencyKey);
    if (existing) {
      if (!sameTransition(existing, accountId, body)) {
        throw new AppError('CONFLICT', 409, 'The idempotency key was already used');
      }
      return { accountId, state: existing.toState, transitionId: existing.id };
    }
    try {
      return await this.repository.transaction(async (client) => {
        const replayed = await this.repository.transitionByKey(idempotencyKey, client);
        if (replayed) {
          if (!sameTransition(replayed, accountId, body)) {
            throw new AppError('CONFLICT', 409, 'The idempotency key was already used');
          }
          return { accountId, state: replayed.toState, transitionId: replayed.id };
        }
        const account = await this.repository.lockAccount(client, accountId);
        if (!account) throw new AppError('NOT_FOUND', 404, 'Not found');
        const history = await client.query<{ from_state: string | null; to_state: string }>(
          `SELECT from_state, to_state
         FROM account_state_transitions
         WHERE account_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
          [accountId],
        );
        const previous = history.rows[0]?.from_state ?? null;
        const decision = decideStaffTransition(
          account.state,
          body.toState,
          body.reasonCode,
          previous === null ? null : parseStoredState(previous),
        );
        if (decision.kind === 'unresolved') {
          throw new AppError('UNRESOLVED_RULE', 409, 'This account outcome is not approved', [
            { path: 'toState', message: decision.question },
          ]);
        }
        if (decision.kind === 'invalid') {
          throw new AppError('CONFLICT', 409, 'The account cannot move to that state');
        }
        const transitionId = await this.repository.insertTransition(client, {
          accountId,
          fromState: account.state,
          toState: body.toState,
          reasonCode: body.reasonCode,
          reason: body.reason,
          actorType: 'STAFF',
          actorUserId: actor.userId,
          idempotencyKey,
          requestId: actor.requestId,
        });
        await this.repository.updateState(client, accountId, body.toState);
        await this.repository.insertAudit(client, {
          eventType: 'account.transition',
          actorUserId: actor.userId,
          targetAccountId: accountId,
          targetProductId: account.productId,
          requestId: actor.requestId,
          metadata: {
            fromState: account.state,
            toState: body.toState,
            reasonCode: body.reasonCode,
          },
        });
        return { accountId, state: body.toState, transitionId };
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'UNRESOLVED_RULE') {
        const question = error.details?.[0]?.message ?? 'UNRESOLVED';
        await this.repository.recordAudit({
          eventType: 'account.transition_rejected',
          actorUserId: actor.userId,
          targetAccountId: accountId,
          targetProductId: null,
          requestId: actor.requestId,
          metadata: { toState: body.toState, question },
        });
      }
      throw error;
    }
  }

  /**
   * Called by a future M-08 adapter after that module has verified a provider event.
   * Matching the price version does not post a ledger entry and does not store a balance.
   */
  async provisionFromVerifiedPurchase(evidence: VerifiedPurchaseEvidence): Promise<TradingAccount> {
    const parsed = verifiedPurchaseEvidenceSchema.safeParse(evidence);
    if (!parsed.success) {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 409, 'Verified purchase evidence is required');
    }
    const input = parsed.data;
    const verifiedAt = new Date(input.verifiedAt);
    if (Number.isNaN(verifiedAt.getTime())) {
      throw new AppError('VALIDATION_ERROR', 400, 'Request validation failed');
    }
    if (verifiedAt.getTime() > this.clock().getTime() + SKEW_MS) {
      throw new AppError('CONFLICT', 409, 'Purchase evidence is not yet valid');
    }
    return presentAccount(
      await this.repository.transaction(async (client) => {
        const price = await this.repository.lockPrice(client, input.priceVersionId);
        if (!price) throw new AppError('NOT_FOUND', 404, 'Not found');
        const applicable =
          verifiedAt.getTime() >= price.validFrom.getTime() &&
          (price.validTo === null || verifiedAt.getTime() < price.validTo.getTime());
        if (!applicable || !decimalsEqual(price.price, input.amount, 4)) {
          throw new AppError('CONFLICT', 409, 'The evidence does not match the price version');
        }
        const active = await this.repository.activationAt(client, price.productId, verifiedAt);
        if (active !== true) {
          throw new AppError('CONFLICT', 409, 'The challenge product is not active');
        }
        const holder = await this.repository.lockUser(client, input.userId);
        if (!holder) throw new AppError('NOT_FOUND', 404, 'Not found');
        if (!holder.emailVerified) {
          throw new AppError(
            'EMAIL_NOT_VERIFIED',
            403,
            'Verify your email before a challenge account can be provisioned',
          );
        }
        if (holder.status !== 'ACTIVE') {
          throw new AppError('CONFLICT', 409, 'The user cannot receive a challenge account');
        }
        const inserted = await this.repository.insertEvidence(client, {
          idempotencyKey: input.idempotencyKey,
          externalReference: input.externalReference,
          userId: input.userId,
          priceVersionId: price.id,
          amount: money(input.amount),
          verifiedAt,
        });
        const evidenceId =
          inserted ?? (await this.repository.evidenceByKey(client, input.idempotencyKey))?.id;
        const existingEvidence = await this.repository.evidenceByKey(client, input.idempotencyKey);
        if (!existingEvidence || !sameEvidence(existingEvidence, input, verifiedAt)) {
          throw new AppError('CONFLICT', 409, 'The idempotency key was already used');
        }
        const existingAccount = await this.repository.accountByEvidence(
          client,
          existingEvidence.id,
        );
        if (existingAccount) return existingAccount;
        if (!evidenceId)
          throw new AppError('CONFLICT', 409, 'The idempotency key was already used');
        const ruleSetVersionId = await this.repository.currentRuleVersionId(client);
        const accountId = await this.repository.insertAccount(client, {
          userId: input.userId,
          initialCapital: money(price.accountSize),
          productId: price.productId,
          priceVersionId: price.id,
          ruleSetVersionId,
          purchaseEvidenceId: existingEvidence.id,
          provisionedAt: verifiedAt,
        });
        await this.repository.insertTransition(client, {
          accountId,
          fromState: null,
          toState: 'PROVISIONED',
          reasonCode: 'PURCHASE_EVIDENCE_ACCEPTED',
          reason: 'Purchase evidence accepted from M-08',
          actorType: 'SYSTEM',
          actorUserId: null,
          idempotencyKey: input.idempotencyKey,
          requestId: null,
        });
        await this.repository.insertAudit(client, {
          eventType: 'account.provisioned',
          actorUserId: null,
          targetAccountId: accountId,
          targetProductId: price.productId,
          requestId: null,
          metadata: {
            priceVersionId: price.id,
            ruleSetVersionId,
            state: 'PROVISIONED',
          },
        });
        const created = await this.repository.getAccount(accountId, client);
        if (!created) throw new Error('Provisioned account is missing');
        return created;
      }),
    );
  }
}

function presentProduct(product: ProductRecord) {
  return {
    id: product.id,
    accountSize: money(product.accountSize),
    currency: 'USD' as const,
    active: product.active,
    price: money(product.price),
    priceVersionId: product.priceVersionId,
    priceValidFrom: product.priceValidFrom.toISOString(),
    decisionRef: product.decisionRef,
  };
}

function presentAccount(account: AccountRecord): TradingAccount {
  return {
    id: account.id,
    userId: account.userId,
    accountType: 'CHALLENGE',
    stage: 'STAGE_1',
    state: account.state,
    initialCapital: money(account.initialCapital),
    currency: 'USD',
    productId: account.productId,
    priceVersionId: account.priceVersionId,
    ruleSetVersionId: account.ruleSetVersionId,
    provisionedAt: account.provisionedAt.toISOString(),
    closedAt: account.closedAt?.toISOString() ?? null,
  };
}

function presentTransition(transition: TransitionRecord) {
  return {
    id: transition.id,
    fromState: transition.fromState,
    toState: transition.toState,
    reasonCode: transition.reasonCode,
    reason: transition.reason,
    actorType: transition.actorType,
    actorUserId: transition.actorUserId,
    createdAt: transition.createdAt.toISOString(),
  };
}

function presentRuleSet(ruleSet: RuleSetRecord) {
  const stages = (['STAGE_1', 'STAGE_2'] as const).map((stage) => ({
    stage,
    parameters: ruleSet.parameters
      .filter((parameter) => parameter.stage === stage)
      .map((parameter) => ({
        parameterKey: parameter.parameterKey,
        status: parameter.status,
        numericValue: formatParameter(parameter.numericValue, parameter.unit),
        unit: parameter.unit,
        referenceId: parameter.referenceId,
      })),
  }));
  return {
    id: ruleSet.id,
    code: ruleSet.code,
    versionNumber: ruleSet.versionNumber,
    decisionRef: ruleSet.decisionRef,
    publishedAt: ruleSet.publishedAt.toISOString(),
    stages,
  };
}

function formatParameter(value: string | null, unit: RuleParameterRecord['unit']): string | null {
  if (value === null || unit === null) return null;
  if (unit === 'DAYS') return canonicalDecimal(value, 0);
  if (unit === 'USD') return canonicalDecimal(value, 2);
  return canonicalDecimal(value, 4);
}

function money(value: string): string {
  try {
    return canonicalDecimal(value, 2);
  } catch (error) {
    if (error instanceof DecimalError) {
      throw new AppError('VALIDATION_ERROR', 400, 'Request validation failed');
    }
    throw error;
  }
}

function commandHash(name: string, body: unknown): string {
  return createHash('sha256')
    .update(`${name}:${stable(body)}`)
    .digest('hex');
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const activationStoredSchema = z.strictObject({
  productId: z.uuid(),
  active: z.boolean(),
});

const priceStoredSchema = z.strictObject({
  priceVersionId: z.uuid(),
  price: z.string().regex(/^(?:0|[1-9]\d{0,14})\.\d{2}$/),
});

const ruleStoredSchema = z.strictObject({
  id: z.uuid(),
  versionNumber: z.number().int().positive(),
});

function readStored<T>(schema: ZodType<T>, storedHash: string, hash: string, response: unknown): T {
  if (storedHash !== hash) {
    throw new AppError('CONFLICT', 409, 'The idempotency key was already used');
  }
  const parsed = schema.safeParse(response);
  if (!parsed.success) throw new AppError('CONFLICT', 409, 'The idempotency key was already used');
  return parsed.data;
}

function sameTransition(
  existing: TransitionRecord,
  accountId: string,
  body: TransitionBody,
): boolean {
  return (
    existing.accountId === accountId &&
    existing.toState === body.toState &&
    existing.reasonCode === body.reasonCode &&
    existing.reason === body.reason
  );
}

function sameEvidence(
  existing: {
    externalReference: string;
    userId: string;
    priceVersionId: string;
    amount: string;
    currency: string;
    verifiedAt: Date;
  },
  input: VerifiedPurchaseEvidence,
  verifiedAt: Date,
): boolean {
  return (
    existing.externalReference === input.externalReference &&
    existing.userId === input.userId &&
    existing.priceVersionId === input.priceVersionId &&
    existing.currency === input.currency &&
    decimalsEqual(existing.amount, input.amount, 4) &&
    existing.verifiedAt.getTime() === verifiedAt.getTime()
  );
}

function applyRuleChanges(
  current: readonly RuleParameterRecord[],
  changes: readonly { stage: 'STAGE_1' | 'STAGE_2'; parameterKey: string; numericValue: string }[],
): RuleParameterRecord[] {
  const seen = new Set<string>();
  const overrides = new Map<string, string>();
  for (const change of changes) {
    const key = `${change.stage}:${change.parameterKey}`;
    if (seen.has(key)) {
      throw new AppError('VALIDATION_ERROR', 400, 'Request validation failed', [
        { path: 'changes', message: 'Invalid value' },
      ]);
    }
    seen.add(key);
    const parameter = current.find(
      (item) => item.stage === change.stage && item.parameterKey === change.parameterKey,
    );
    if (!parameter) {
      throw new AppError('VALIDATION_ERROR', 400, 'Request validation failed', [
        { path: 'changes', message: 'Invalid value' },
      ]);
    }
    if (
      parameter.status !== 'CONFIRMED' ||
      parameter.unit === null ||
      parameter.numericValue === null
    ) {
      throw new AppError('UNRESOLVED_RULE', 409, 'An unresolved rule cannot be given a value', [
        { path: 'parameterKey', message: parameter.referenceId },
      ]);
    }
    const numericValue = canonicalChange(change.numericValue, parameter.unit);
    if (decimalsEqual(numericValue, parameter.numericValue, 4)) {
      throw new AppError('CONFLICT', 409, 'The rule value is already in effect');
    }
    overrides.set(key, numericValue);
  }
  return current.map((parameter) => {
    const override = overrides.get(`${parameter.stage}:${parameter.parameterKey}`);
    if (override === undefined) return parameter;
    return { ...parameter, numericValue: override };
  });
}

function canonicalChange(value: string, unit: 'PCT' | 'DAYS' | 'USD' | 'RATE'): string {
  try {
    if (unit === 'DAYS') {
      const canonical = canonicalDecimal(value, 0);
      if (decimalLessThan(canonical, '0', 0) || decimalGreaterThan(canonical, '10000', 0)) {
        throw new DecimalError();
      }
      return canonicalDecimal(canonical, 4);
    }
    if (unit === 'USD') {
      const canonical = canonicalDecimal(value, 2);
      if (decimalLessThan(canonical, '0.00', 2) || decimalGreaterThan(canonical, '10000.00', 2)) {
        throw new DecimalError();
      }
      return canonicalDecimal(canonical, 4);
    }
    const canonical = canonicalDecimal(value, 4);
    if (decimalLessThan(canonical, '0.0000', 4) || decimalGreaterThan(canonical, '100.0000', 4)) {
      throw new DecimalError();
    }
    return canonical;
  } catch (error) {
    if (error instanceof DecimalError) {
      throw new AppError('VALIDATION_ERROR', 400, 'Request validation failed', [
        { path: 'numericValue', message: 'Invalid value' },
      ]);
    }
    throw error;
  }
}

function parseStoredState(value: string): AccountLifecycleState {
  switch (value) {
    case 'PROVISIONED':
    case 'ACTIVE':
    case 'PASSED':
    case 'FAILED':
    case 'EXPIRED':
    case 'SUSPENDED':
    case 'UNDER_REVIEW':
    case 'CLOSED':
      return value;
    default:
      throw new Error('Unexpected account state');
  }
}

function mapConstraint(error: unknown): Error {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23514') {
    return new AppError('VALIDATION_ERROR', 400, 'Request validation failed', [
      { path: 'accountSize', message: 'Invalid value' },
    ]);
  }
  return error instanceof Error ? error : new Error('Catalogue command failed');
}
