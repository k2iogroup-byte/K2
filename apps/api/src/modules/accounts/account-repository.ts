import type { AccountLifecycleState } from '@k2/shared';
import type pg from 'pg';

export class UniqueViolation extends Error {
  readonly constraint: string;

  constructor(constraint: string) {
    super('Unique constraint violation');
    this.name = 'UniqueViolation';
    this.constraint = constraint;
  }
}

type Db = pg.Pool | pg.PoolClient;

export type ProductRecord = {
  id: string;
  accountSize: string;
  currency: 'USD';
  active: boolean;
  priceVersionId: string;
  price: string;
  priceValidFrom: Date;
  decisionRef: string;
};

export type PriceRecord = {
  id: string;
  price: string;
  currency: 'USD';
  validFrom: Date;
  validTo: Date | null;
  decisionRef: string;
};

export type RuleParameterRecord = {
  stage: 'STAGE_1' | 'STAGE_2';
  parameterKey: string;
  status: 'CONFIRMED' | 'UNRESOLVED';
  numericValue: string | null;
  unit: 'PCT' | 'DAYS' | 'USD' | 'RATE' | null;
  referenceId: string;
};

export type RuleSetRecord = {
  id: string;
  code: 'CHALLENGE_EVALUATION';
  versionNumber: number;
  decisionRef: string;
  publishedAt: Date;
  parameters: readonly RuleParameterRecord[];
};

export type AccountRecord = {
  id: string;
  userId: string;
  accountType: 'CHALLENGE';
  stage: 'STAGE_1';
  state: AccountLifecycleState;
  initialCapital: string;
  currency: 'USD';
  productId: string;
  priceVersionId: string;
  ruleSetVersionId: string;
  purchaseEvidenceId: string;
  provisionedAt: Date;
  closedAt: Date | null;
};

export type TransitionRecord = {
  id: string;
  accountId: string;
  fromState: AccountLifecycleState | null;
  toState: AccountLifecycleState;
  reasonCode: string;
  reason: string;
  actorType: 'SYSTEM' | 'STAFF';
  actorUserId: string | null;
  idempotencyKey: string;
  createdAt: Date;
};

export type LockedPrice = {
  id: string;
  productId: string;
  price: string;
  currency: 'USD';
  validFrom: Date;
  validTo: Date | null;
  accountSize: string;
  productActive: boolean;
};

export type EvidenceRecord = {
  id: string;
  idempotencyKey: string;
  externalReference: string;
  userId: string;
  priceVersionId: string;
  amount: string;
  currency: string;
  verifiedAt: Date;
};

export type StoredCommand = {
  requestHash: string;
  response: unknown;
};

type AuditInput = {
  eventType: string;
  actorUserId: string | null;
  targetAccountId: string | null;
  targetProductId: string | null;
  requestId: string | null;
  metadata: Record<string, string | number | boolean | null>;
};

export class AccountRepository {
  constructor(private readonly pool: pg.Pool) {}

  async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listPublicProducts(): Promise<ProductRecord[]> {
    const result = await this.pool.query<ProductRow>(
      `SELECT p.id, p.account_size, p.currency, p.active,
              v.id AS price_version_id, v.price, v.valid_from, v.decision_ref
       FROM challenge_products p
       JOIN product_price_versions v ON v.product_id = p.id AND v.valid_to IS NULL
       WHERE p.active
       ORDER BY p.account_size`,
    );
    return result.rows.map(mapProduct);
  }

  async listStaffProducts(): Promise<ProductRecord[]> {
    const result = await this.pool.query<ProductRow>(
      `SELECT p.id, p.account_size, p.currency, p.active,
              v.id AS price_version_id, v.price, v.valid_from, v.decision_ref
       FROM challenge_products p
       JOIN product_price_versions v ON v.product_id = p.id AND v.valid_to IS NULL
       ORDER BY p.account_size`,
    );
    return result.rows.map(mapProduct);
  }

  async listPrices(productId: string): Promise<PriceRecord[]> {
    const result = await this.pool.query<{
      id: string;
      price: string;
      currency: string;
      valid_from: Date;
      valid_to: Date | null;
      decision_ref: string;
    }>(
      `SELECT id, price::text, currency, valid_from, valid_to, decision_ref
       FROM product_price_versions
       WHERE product_id = $1
       ORDER BY valid_from, created_at`,
      [productId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      price: row.price,
      currency: 'USD',
      validFrom: row.valid_from,
      validTo: row.valid_to,
      decisionRef: row.decision_ref,
    }));
  }

  async currentRuleSet(): Promise<RuleSetRecord> {
    const version = await this.pool.query<{ id: string }>(
      `SELECT id FROM rule_set_versions ORDER BY version_number DESC LIMIT 1`,
    );
    const id = version.rows[0]?.id;
    if (!id) throw new Error('Challenge rule set is missing');
    const ruleSet = await this.ruleSet(id);
    if (!ruleSet) throw new Error('Challenge rule set is missing');
    return ruleSet;
  }

  async ruleSet(id: string): Promise<RuleSetRecord | null> {
    const header = await this.pool.query<{
      id: string;
      code: string;
      version_number: number;
      decision_ref: string;
      published_at: Date;
    }>(
      `SELECT v.id, s.code, v.version_number, v.decision_ref, v.published_at
       FROM rule_set_versions v
       JOIN rule_sets s ON s.id = v.rule_set_id
       WHERE v.id = $1`,
      [id],
    );
    const row = header.rows[0];
    if (!row) return null;
    if (row.code !== 'CHALLENGE_EVALUATION') throw new Error('Challenge rule set is missing');
    const parameters = await this.pool.query<{
      stage: string;
      parameter_key: string;
      status: string;
      numeric_value: string | null;
      unit: string | null;
      reference_id: string;
    }>(
      `SELECT stage, parameter_key, status, numeric_value::text, unit, reference_id
       FROM rule_parameters
       WHERE rule_set_version_id = $1
       ORDER BY stage, parameter_key`,
      [id],
    );
    return {
      id: row.id,
      code: 'CHALLENGE_EVALUATION',
      versionNumber: row.version_number,
      decisionRef: row.decision_ref,
      publishedAt: row.published_at,
      parameters: parameters.rows.map((parameter) => ({
        stage: parameter.stage === 'STAGE_2' ? 'STAGE_2' : 'STAGE_1',
        parameterKey: parameter.parameter_key,
        status: parameter.status === 'UNRESOLVED' ? 'UNRESOLVED' : 'CONFIRMED',
        numericValue: parameter.numeric_value,
        unit: parseUnit(parameter.unit),
        referenceId: parameter.reference_id,
      })),
    };
  }

  async listAccounts(userId: string): Promise<AccountRecord[]> {
    const result = await this.pool.query<AccountRow>(
      `${ACCOUNT_SELECT} WHERE user_id = $1 ORDER BY created_at, id`,
      [userId],
    );
    return result.rows.map(mapAccount);
  }

  async getAccount(id: string, db: Db = this.pool): Promise<AccountRecord | null> {
    const result = await db.query<AccountRow>(`${ACCOUNT_SELECT} WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row ? mapAccount(row) : null;
  }

  async listTransitions(accountId: string): Promise<TransitionRecord[]> {
    const result = await this.pool.query<TransitionRow>(
      `${TRANSITION_SELECT} WHERE account_id = $1 ORDER BY created_at, id`,
      [accountId],
    );
    return result.rows.map(mapTransition);
  }

  async transitionByKey(key: string, db: Db = this.pool): Promise<TransitionRecord | null> {
    const result = await db.query<TransitionRow>(
      `${TRANSITION_SELECT} WHERE idempotency_key = $1`,
      [key],
    );
    const row = result.rows[0];
    return row ? mapTransition(row) : null;
  }

  async command(key: string, db: Db = this.pool): Promise<StoredCommand | null> {
    const result = await db.query<{ request_hash: string; response: unknown }>(
      `SELECT request_hash, response FROM catalogue_commands WHERE idempotency_key = $1`,
      [key],
    );
    const row = result.rows[0];
    return row ? { requestHash: row.request_hash, response: row.response } : null;
  }

  async insertCommand(
    client: pg.PoolClient,
    key: string,
    commandName: string,
    requestHash: string,
    response: unknown,
  ): Promise<void> {
    await query(
      client,
      `INSERT INTO catalogue_commands (idempotency_key, command_name, request_hash, response) VALUES ($1, $2, $3, $4::jsonb)`,
      [key, commandName, requestHash, JSON.stringify(response)],
    );
  }

  async lockUser(
    client: pg.PoolClient,
    userId: string,
  ): Promise<{ status: string; emailVerified: boolean } | null> {
    const result = await client.query<{ status: string; email_verified_at: Date | null }>(
      `SELECT status, email_verified_at FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { status: row.status, emailVerified: row.email_verified_at !== null };
  }

  async lockPrice(client: pg.PoolClient, priceVersionId: string): Promise<LockedPrice | null> {
    const result = await client.query<{
      id: string;
      product_id: string;
      price: string;
      currency: string;
      valid_from: Date;
      valid_to: Date | null;
      account_size: string;
      active: boolean;
    }>(
      `SELECT v.id, v.product_id, v.price::text, v.currency, v.valid_from, v.valid_to,
              p.account_size::text, p.active
       FROM product_price_versions v
       JOIN challenge_products p ON p.id = v.product_id
       WHERE v.id = $1
       FOR UPDATE OF v, p`,
      [priceVersionId],
    );
    const row = result.rows[0];
    if (!row || row.currency !== 'USD') return null;
    return {
      id: row.id,
      productId: row.product_id,
      price: row.price,
      currency: 'USD',
      validFrom: row.valid_from,
      validTo: row.valid_to,
      accountSize: row.account_size,
      productActive: row.active,
    };
  }

  async activationAt(client: pg.PoolClient, productId: string, at: Date): Promise<boolean | null> {
    const result = await client.query<{ active: boolean }>(
      `SELECT active
       FROM product_activation_events
       WHERE product_id = $1 AND effective_at <= $2
       ORDER BY effective_at DESC, created_at DESC
       LIMIT 1`,
      [productId, at.toISOString()],
    );
    return result.rows[0]?.active ?? null;
  }

  async currentRuleVersionId(client: pg.PoolClient): Promise<string> {
    await this.lockRuleSet(client);
    const result = await client.query<{ id: string }>(
      `SELECT id FROM rule_set_versions ORDER BY version_number DESC LIMIT 1`,
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error('Challenge rule set is missing');
    return id;
  }

  private async lockRuleSet(client: pg.PoolClient): Promise<void> {
    const locked = await client.query(
      `SELECT id FROM rule_sets WHERE code = 'CHALLENGE_EVALUATION' FOR UPDATE`,
    );
    if ((locked.rowCount ?? 0) !== 1) throw new Error('Challenge rule set is missing');
  }

  async evidenceByKey(client: pg.PoolClient, key: string): Promise<EvidenceRecord | null> {
    const result = await client.query<{
      id: string;
      idempotency_key: string;
      external_reference: string;
      user_id: string;
      price_version_id: string;
      amount: string;
      currency: string;
      verified_at: Date;
    }>(
      `SELECT id, idempotency_key, external_reference, user_id, price_version_id,
              amount::text, currency, verified_at
       FROM purchase_evidence_references
       WHERE idempotency_key = $1`,
      [key],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      externalReference: row.external_reference,
      userId: row.user_id,
      priceVersionId: row.price_version_id,
      amount: row.amount,
      currency: row.currency,
      verifiedAt: row.verified_at,
    };
  }

  async insertEvidence(
    client: pg.PoolClient,
    input: {
      idempotencyKey: string;
      externalReference: string;
      userId: string;
      priceVersionId: string;
      amount: string;
      verifiedAt: Date;
    },
  ): Promise<string | null> {
    const result = await query<{ id: string }>(
      client,
      `INSERT INTO purchase_evidence_references (
         source_system, idempotency_key, external_reference, user_id, price_version_id,
         amount, currency, verified_at
       ) VALUES ('M-08', $1, $2, $3, $4, $5::numeric, 'USD', $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        input.idempotencyKey,
        input.externalReference,
        input.userId,
        input.priceVersionId,
        input.amount,
        input.verifiedAt.toISOString(),
      ],
    );
    return result.rows[0]?.id ?? null;
  }

  async accountByEvidence(
    client: pg.PoolClient,
    evidenceId: string,
  ): Promise<AccountRecord | null> {
    const result = await client.query<AccountRow>(
      `${ACCOUNT_SELECT} WHERE purchase_evidence_id = $1`,
      [evidenceId],
    );
    const row = result.rows[0];
    return row ? mapAccount(row) : null;
  }

  async insertAccount(
    client: pg.PoolClient,
    input: {
      userId: string;
      initialCapital: string;
      productId: string;
      priceVersionId: string;
      ruleSetVersionId: string;
      purchaseEvidenceId: string;
      provisionedAt: Date;
    },
  ): Promise<string> {
    const result = await query<{ id: string }>(
      client,
      `INSERT INTO trading_accounts (
         user_id, account_type, stage, state, initial_capital, currency, product_id,
         price_version_id, rule_set_version_id, purchase_evidence_id, provisioned_at
       ) VALUES ($1, 'CHALLENGE', 'STAGE_1', 'PROVISIONED', $2::numeric, 'USD', $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.userId,
        input.initialCapital,
        input.productId,
        input.priceVersionId,
        input.ruleSetVersionId,
        input.purchaseEvidenceId,
        input.provisionedAt.toISOString(),
      ],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error('Account insert did not return an id');
    return id;
  }

  async lockAccount(client: pg.PoolClient, accountId: string): Promise<AccountRecord | null> {
    const result = await client.query<AccountRow>(`${ACCOUNT_SELECT} WHERE id = $1 FOR UPDATE`, [
      accountId,
    ]);
    const row = result.rows[0];
    return row ? mapAccount(row) : null;
  }

  async insertTransition(
    client: pg.PoolClient,
    input: {
      accountId: string;
      fromState: AccountLifecycleState | null;
      toState: AccountLifecycleState;
      reasonCode: string;
      reason: string;
      actorType: 'SYSTEM' | 'STAFF';
      actorUserId: string | null;
      idempotencyKey: string;
      requestId: string | null;
    },
  ): Promise<string> {
    const result = await query<{ id: string }>(
      client,
      `INSERT INTO account_state_transitions (
         account_id, from_state, to_state, reason_code, reason, actor_type, actor_user_id,
         idempotency_key, request_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        input.accountId,
        input.fromState,
        input.toState,
        input.reasonCode,
        input.reason,
        input.actorType,
        input.actorUserId,
        input.idempotencyKey,
        input.requestId,
      ],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error('Transition insert did not return an id');
    return id;
  }

  async updateState(
    client: pg.PoolClient,
    accountId: string,
    state: AccountLifecycleState,
  ): Promise<void> {
    await query(
      client,
      `UPDATE trading_accounts
       SET state = $2,
           closed_at = CASE WHEN $2 = 'CLOSED' THEN now() ELSE closed_at END
       WHERE id = $1`,
      [accountId, state],
    );
  }

  async recordAudit(input: AuditInput): Promise<void> {
    await this.insertAudit(this.pool, input);
  }

  async insertAudit(db: Db, input: AuditInput): Promise<void> {
    await query(
      db,
      `INSERT INTO challenge_audit_events (
         event_type, actor_user_id, target_account_id, target_product_id, request_id, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        input.eventType,
        input.actorUserId,
        input.targetAccountId,
        input.targetProductId,
        input.requestId,
        JSON.stringify(input.metadata),
      ],
    );
  }

  async insertProduct(client: pg.PoolClient, accountSize: string): Promise<string> {
    const result = await query<{ id: string }>(
      client,
      `INSERT INTO challenge_products (account_size, currency, active)
       VALUES ($1::numeric, 'USD', true)
       RETURNING id`,
      [accountSize],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error('Product insert did not return an id');
    return id;
  }

  async insertPrice(
    client: pg.PoolClient,
    input: {
      productId: string;
      price: string;
      validFrom: Date;
      decisionRef: string;
      createdBy: string | null;
    },
  ): Promise<string> {
    const result = await query<{ id: string }>(
      client,
      `INSERT INTO product_price_versions (
         product_id, price, currency, valid_from, decision_ref, created_by
       ) VALUES ($1, $2::numeric, 'USD', $3, $4, $5)
       RETURNING id`,
      [
        input.productId,
        input.price,
        input.validFrom.toISOString(),
        input.decisionRef,
        input.createdBy,
      ],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error('Price insert did not return an id');
    return id;
  }

  async closeOpenPrice(client: pg.PoolClient, productId: string, validTo: Date): Promise<string> {
    const result = await query<{ price: string }>(
      client,
      `UPDATE product_price_versions
       SET valid_to = $2
       WHERE product_id = $1 AND valid_to IS NULL
       RETURNING price::text`,
      [productId, validTo.toISOString()],
    );
    const price = result.rows[0]?.price;
    if (!price) throw new Error('Open price version is missing');
    return price;
  }

  async lockProduct(client: pg.PoolClient, productId: string): Promise<{ active: boolean } | null> {
    const result = await client.query<{ active: boolean }>(
      `SELECT active FROM challenge_products WHERE id = $1 FOR UPDATE`,
      [productId],
    );
    return result.rows[0] ?? null;
  }

  async insertActivation(
    client: pg.PoolClient,
    input: {
      productId: string;
      active: boolean;
      actorUserId: string;
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<void> {
    await query(
      client,
      `INSERT INTO product_activation_events (
         product_id, active, actor_user_id, reason, idempotency_key
       ) VALUES ($1, $2, $3, $4, $5)`,
      [input.productId, input.active, input.actorUserId, input.reason, input.idempotencyKey],
    );
    await query(client, `UPDATE challenge_products SET active = $2 WHERE id = $1`, [
      input.productId,
      input.active,
    ]);
  }

  async lockRuleParameters(client: pg.PoolClient): Promise<{
    versionNumber: number;
    parameters: readonly RuleParameterRecord[];
  }> {
    await this.lockRuleSet(client);
    const version = await client.query<{ id: string; version_number: number }>(
      `SELECT id, version_number
       FROM rule_set_versions
       ORDER BY version_number DESC
       LIMIT 1`,
    );
    const row = version.rows[0];
    if (!row) throw new Error('Challenge rule set is missing');
    const parameters = await client.query<{
      stage: string;
      parameter_key: string;
      status: string;
      numeric_value: string | null;
      unit: string | null;
      reference_id: string;
    }>(
      `SELECT stage, parameter_key, status, numeric_value::text, unit, reference_id
       FROM rule_parameters
       WHERE rule_set_version_id = $1
       ORDER BY stage, parameter_key`,
      [row.id],
    );
    return {
      versionNumber: row.version_number,
      parameters: parameters.rows.map((parameter) => ({
        stage: parameter.stage === 'STAGE_2' ? 'STAGE_2' : 'STAGE_1',
        parameterKey: parameter.parameter_key,
        status: parameter.status === 'UNRESOLVED' ? 'UNRESOLVED' : 'CONFIRMED',
        numericValue: parameter.numeric_value,
        unit: parseUnit(parameter.unit),
        referenceId: parameter.reference_id,
      })),
    };
  }

  async insertRuleVersion(
    client: pg.PoolClient,
    input: {
      versionNumber: number;
      decisionRef: string;
      createdBy: string;
      parameters: readonly RuleParameterRecord[];
    },
  ): Promise<string> {
    const ruleSet = await client.query<{ id: string }>(
      `SELECT id FROM rule_sets WHERE code = 'CHALLENGE_EVALUATION'`,
    );
    const ruleSetId = ruleSet.rows[0]?.id;
    if (!ruleSetId) throw new Error('Challenge rule set is missing');
    const inserted = await query<{ id: string }>(
      client,
      `INSERT INTO rule_set_versions (rule_set_id, version_number, decision_ref, published_at, created_by)
       VALUES ($1, $2, $3, now(), $4)
       RETURNING id`,
      [ruleSetId, input.versionNumber, input.decisionRef, input.createdBy],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error('Rule version insert did not return an id');
    for (const parameter of input.parameters) {
      await query(
        client,
        `INSERT INTO rule_parameters (
           rule_set_version_id, stage, parameter_key, status, numeric_value, unit, reference_id
         ) VALUES ($1, $2, $3, $4, $5::numeric, $6, $7)`,
        [
          id,
          parameter.stage,
          parameter.parameterKey,
          parameter.status,
          parameter.numericValue,
          parameter.unit,
          parameter.referenceId,
        ],
      );
    }
    return id;
  }
}

const ACCOUNT_SELECT = `SELECT id, user_id, account_type, stage, state, initial_capital::text,
  currency, product_id, price_version_id, rule_set_version_id, purchase_evidence_id,
  provisioned_at, closed_at
  FROM trading_accounts`;

const TRANSITION_SELECT = `SELECT id, account_id, from_state, to_state, reason_code, reason,
  actor_type, actor_user_id, idempotency_key, created_at
  FROM account_state_transitions`;

type ProductRow = {
  id: string;
  account_size: string;
  currency: string;
  active: boolean;
  price_version_id: string;
  price: string;
  valid_from: Date;
  decision_ref: string;
};

type AccountRow = {
  id: string;
  user_id: string;
  account_type: string;
  stage: string;
  state: string;
  initial_capital: string;
  currency: string;
  product_id: string;
  price_version_id: string;
  rule_set_version_id: string;
  purchase_evidence_id: string;
  provisioned_at: Date;
  closed_at: Date | null;
};

type TransitionRow = {
  id: string;
  account_id: string;
  from_state: string | null;
  to_state: string;
  reason_code: string;
  reason: string;
  actor_type: string;
  actor_user_id: string | null;
  idempotency_key: string;
  created_at: Date;
};

function mapProduct(row: ProductRow): ProductRecord {
  if (row.currency !== 'USD') throw new Error('Unexpected product currency');
  return {
    id: row.id,
    accountSize: row.account_size,
    currency: 'USD',
    active: row.active,
    priceVersionId: row.price_version_id,
    price: row.price,
    priceValidFrom: row.valid_from,
    decisionRef: row.decision_ref,
  };
}

function mapAccount(row: AccountRow): AccountRecord {
  if (row.account_type !== 'CHALLENGE' || row.stage !== 'STAGE_1' || row.currency !== 'USD') {
    throw new Error('Unexpected trading account row');
  }
  return {
    id: row.id,
    userId: row.user_id,
    accountType: 'CHALLENGE',
    stage: 'STAGE_1',
    state: parseState(row.state),
    initialCapital: row.initial_capital,
    currency: 'USD',
    productId: row.product_id,
    priceVersionId: row.price_version_id,
    ruleSetVersionId: row.rule_set_version_id,
    purchaseEvidenceId: row.purchase_evidence_id,
    provisionedAt: row.provisioned_at,
    closedAt: row.closed_at,
  };
}

function mapTransition(row: TransitionRow): TransitionRecord {
  if (row.actor_type !== 'SYSTEM' && row.actor_type !== 'STAFF') {
    throw new Error('Unexpected transition actor');
  }
  return {
    id: row.id,
    accountId: row.account_id,
    fromState: row.from_state === null ? null : parseState(row.from_state),
    toState: parseState(row.to_state),
    reasonCode: row.reason_code,
    reason: row.reason,
    actorType: row.actor_type,
    actorUserId: row.actor_user_id,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

function parseState(value: string): AccountLifecycleState {
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

function parseUnit(value: string | null): RuleParameterRecord['unit'] {
  if (value === null) return null;
  if (value === 'PCT' || value === 'DAYS' || value === 'USD' || value === 'RATE') return value;
  throw new Error('Unexpected rule parameter unit');
}

async function query<T extends pg.QueryResultRow>(
  db: Db,
  sql: string,
  values: readonly unknown[],
): Promise<pg.QueryResult<T>> {
  try {
    return await db.query<T>(sql, values as unknown[]);
  } catch (error) {
    const unique = uniqueViolation(error);
    if (unique) throw new UniqueViolation(unique);
    throw error;
  }
}

function uniqueViolation(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  if (error.code !== '23505') return null;
  return 'constraint' in error && typeof error.constraint === 'string' ? error.constraint : '';
}
