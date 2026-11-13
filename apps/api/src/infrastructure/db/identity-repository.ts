import type { AccountStatus, RoleCode } from '@k2/shared';
import { accountStatusSchema, roleCodeSchema } from '@k2/shared';
import type pg from 'pg';

export class UniqueViolation extends Error {
  constructor() {
    super('Unique constraint violation');
    this.name = 'UniqueViolation';
  }
}

export type CredentialUser = {
  id: string;
  email: string;
  status: AccountStatus;
  emailVerifiedAt: Date | null;
  passwordHash: string;
};

export type SessionContext = {
  userId: string;
  sessionId: string;
  email: string;
  displayName: string | null;
  status: AccountStatus;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  roles: readonly RoleCode[];
  permissions: readonly string[];
  staff: boolean;
  mfaEnrolled: boolean;
  mfaVerifiedAt: Date | null;
  csrfHash: string;
  expiresAt: Date;
};

export type PendingSession = {
  sessionId: string;
  userId: string;
  email: string;
  status: AccountStatus;
  csrfHash: string;
  expiresAt: Date;
};

export type ListedSession = {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
};

export type ProfileRecord = {
  id: string;
  email: string;
  displayName: string | null;
  status: AccountStatus;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  roles: readonly RoleCode[];
  mfaEnrolled: boolean;
};

export type TotpFactor = {
  id: string;
  ciphertext: string;
  nonce: string;
};

export type OpenInvitation = {
  email: string;
  roleCode: RoleCode;
  invitedBy: string;
};

export type AuditEvent = {
  id: string;
  eventType: string;
  actorUserId: string | null;
  targetUserId: string | null;
  ip: string | null;
  createdAt: Date;
  metadata: Record<string, string | number | boolean | null>;
};

export type AuditWrite = {
  eventType: string;
  actorUserId: string | null;
  targetUserId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, string | number | boolean | null>;
};

type Db = pg.Pool | pg.PoolClient;

type NewUser = {
  email: string;
  passwordHash: string;
  parameters: { memoryCost: number; timeCost: number; parallelism: number };
  role: RoleCode;
  grantedBy: string | null;
  emailVerified: boolean;
};

export class IdentityRepository {
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

  async findUserByEmail(email: string): Promise<CredentialUser | null> {
    const result = await this.pool.query<{
      id: string;
      email: string;
      status: string;
      email_verified_at: Date | null;
      password_hash: string;
    }>(
      `SELECT u.id, u.email, u.status, u.email_verified_at, c.password_hash
       FROM users u
       JOIN credentials c ON c.user_id = u.id
       WHERE u.email = $1`,
      [email],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      status: parseStatus(row.status),
      emailVerifiedAt: row.email_verified_at,
      passwordHash: row.password_hash,
    };
  }

  async emailExists(email: string, db: Db = this.pool): Promise<boolean> {
    const result = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
    return (result.rowCount ?? 0) > 0;
  }

  async insertUser(client: pg.PoolClient, input: NewUser): Promise<string> {
    try {
      const user = await client.query<{ id: string }>(
        `INSERT INTO users (email, email_verified_at)
         VALUES ($1, CASE WHEN $2::boolean THEN now() ELSE NULL END)
         RETURNING id`,
        [input.email, input.emailVerified],
      );
      const id = user.rows[0]?.id;
      if (!id) throw new Error('User insert did not return an id');
      await client.query(
        `INSERT INTO credentials (user_id, password_hash, algorithm, parameters)
         VALUES ($1, $2, 'argon2id', $3::jsonb)`,
        [id, input.passwordHash, JSON.stringify(input.parameters)],
      );
      await client.query(
        `INSERT INTO user_roles (user_id, role_code, granted_by)
         VALUES ($1, $2, $3)`,
        [id, input.role, input.grantedBy],
      );
      return id;
    } catch (error) {
      if (pgCode(error) === '23505') throw new UniqueViolation();
      throw error;
    }
  }

  async countAdmins(db: Db = this.pool): Promise<number> {
    const result = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM user_roles WHERE role_code = 'ADMIN'`,
    );
    return result.rows[0]?.count ?? 0;
  }

  async lockUser(
    client: pg.PoolClient,
    userId: string,
  ): Promise<{ id: string; status: AccountStatus } | null> {
    const result = await client.query<{ id: string; status: string }>(
      'SELECT id, status FROM users WHERE id = $1 FOR UPDATE',
      [userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { id: row.id, status: parseStatus(row.status) };
  }

  async lockAdminRows(client: pg.PoolClient): Promise<void> {
    await client.query(`SELECT user_id FROM user_roles WHERE role_code = 'ADMIN' FOR UPDATE`);
  }

  async userHasRole(client: pg.PoolClient, userId: string, role: RoleCode): Promise<boolean> {
    const result = await client.query(
      'SELECT 1 FROM user_roles WHERE user_id = $1 AND role_code = $2',
      [userId, role],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async replaceRoles(
    client: pg.PoolClient,
    userId: string,
    roles: readonly RoleCode[],
    grantedBy: string,
  ): Promise<void> {
    await client.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
    for (const role of roles) {
      await client.query(
        'INSERT INTO user_roles (user_id, role_code, granted_by) VALUES ($1, $2, $3)',
        [userId, role, grantedBy],
      );
    }
  }

  async updateStatus(client: pg.PoolClient, userId: string, status: AccountStatus): Promise<void> {
    await client.query('UPDATE users SET status = $2, updated_at = now() WHERE id = $1', [
      userId,
      status,
    ]);
  }

  async updateDisplayName(
    userId: string,
    displayName: string | null,
  ): Promise<ProfileRecord | null> {
    const result = await this.pool.query<{ id: string }>(
      'UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1 RETURNING id',
      [userId, displayName],
    );
    if (!result.rows[0]) return null;
    return this.findProfile(userId);
  }

  async findProfile(userId: string): Promise<ProfileRecord | null> {
    const result = await this.pool.query<{
      id: string;
      email: string;
      display_name: string | null;
      status: string;
      email_verified_at: Date | null;
      created_at: Date;
      roles: string[] | null;
      mfa_enrolled: boolean;
    }>(
      `SELECT u.id, u.email, u.display_name, u.status, u.email_verified_at, u.created_at,
              COALESCE(
                array_agg(DISTINCT ur.role_code) FILTER (WHERE ur.role_code IS NOT NULL),
                ARRAY[]::text[]
              ) AS roles,
              EXISTS (
                SELECT 1 FROM mfa_factors f
                WHERE f.user_id = u.id AND f.confirmed_at IS NOT NULL AND f.disabled_at IS NULL
              ) AS mfa_enrolled
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       WHERE u.id = $1
       GROUP BY u.id`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      status: parseStatus(row.status),
      emailVerifiedAt: row.email_verified_at,
      createdAt: row.created_at,
      roles: parseRoles(row.roles ?? []),
      mfaEnrolled: row.mfa_enrolled,
    };
  }

  async updatePassword(client: pg.PoolClient, userId: string, passwordHash: string): Promise<void> {
    await client.query(
      `UPDATE credentials
       SET password_hash = $2, rotated_at = now(), parameters = $3::jsonb
       WHERE user_id = $1`,
      [userId, passwordHash, JSON.stringify({ memoryCost: 19456, timeCost: 2, parallelism: 1 })],
    );
  }

  async insertToken(
    client: pg.PoolClient,
    table: 'email_verification_tokens' | 'password_reset_tokens',
    userId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ${table} (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [userId, tokenHash, expiresAt],
    );
  }

  async invalidateTokens(
    client: pg.PoolClient,
    table: 'email_verification_tokens' | 'password_reset_tokens',
    userId: string,
  ): Promise<void> {
    await client.query(
      `UPDATE ${table} SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
  }

  async consumeToken(
    client: pg.PoolClient,
    table: 'email_verification_tokens' | 'password_reset_tokens',
    tokenHash: string,
  ): Promise<string | null> {
    const result = await client.query<{ user_id: string }>(
      `UPDATE ${table}
       SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [tokenHash],
    );
    return result.rows[0]?.user_id ?? null;
  }

  async markEmailVerified(client: pg.PoolClient, userId: string): Promise<void> {
    await client.query(
      `UPDATE users
       SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
       WHERE id = $1`,
      [userId],
    );
  }

  async createSession(
    client: pg.PoolClient,
    input: {
      userId: string;
      tokenHash: string;
      csrfHash: string;
      kind: 'full' | 'mfa_pending';
      expiresAt: Date;
      ip: string | null;
      userAgent: string | null;
      rotatedFromId: string | null;
      mfaVerifiedAt: Date | null;
    },
  ): Promise<{ id: string; expiresAt: Date }> {
    const result = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO sessions (
         user_id, token_hash, csrf_hash, kind, expires_at, ip, user_agent, rotated_from_id, mfa_verified_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, expires_at`,
      [
        input.userId,
        input.tokenHash,
        input.csrfHash,
        input.kind,
        input.expiresAt,
        input.ip,
        input.userAgent,
        input.rotatedFromId,
        input.mfaVerifiedAt,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Session insert did not return an id');
    return { id: row.id, expiresAt: row.expires_at };
  }

  async revokeByHash(tokenHash: string): Promise<void> {
    await this.pool.query(
      `UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
  }

  async expireIfDue(
    tokenHash: string,
    kind: 'full' | 'mfa_pending',
    idleSeconds: number,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE sessions
       SET revoked_at = now()
       WHERE token_hash = $1
         AND kind = $2
         AND revoked_at IS NULL
         AND (expires_at <= now() OR last_seen_at <= now() - make_interval(secs => $3::int))`,
      [tokenHash, kind, idleSeconds],
    );
  }

  async findFullSession(tokenHash: string, idleSeconds: number): Promise<SessionContext | null> {
    const result = await this.pool.query<{
      user_id: string;
      session_id: string;
      email: string;
      display_name: string | null;
      status: string;
      email_verified_at: Date | null;
      created_at: Date;
      roles: string[] | null;
      permissions: string[] | null;
      staff: boolean;
      mfa_enrolled: boolean;
      mfa_verified_at: Date | null;
      csrf_hash: string;
      expires_at: Date;
    }>(
      `SELECT u.id AS user_id, s.id AS session_id, u.email, u.display_name, u.status,
              u.email_verified_at, u.created_at,
              COALESCE(array_agg(DISTINCT ur.role_code) FILTER (WHERE ur.role_code IS NOT NULL), ARRAY[]::text[]) AS roles,
              COALESCE(array_agg(DISTINCT rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), ARRAY[]::text[]) AS permissions,
              COALESCE(bool_or(r.is_staff), false) AS staff,
              EXISTS (
                SELECT 1 FROM mfa_factors f
                WHERE f.user_id = u.id AND f.confirmed_at IS NOT NULL AND f.disabled_at IS NULL
              ) AS mfa_enrolled,
              s.mfa_verified_at, s.csrf_hash, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.code = ur.role_code
       LEFT JOIN role_permissions rp ON rp.role_code = ur.role_code
       WHERE s.token_hash = $1
         AND s.kind = 'full'
         AND s.revoked_at IS NULL
         AND s.expires_at > now()
         AND s.last_seen_at > now() - make_interval(secs => $2::int)
       GROUP BY u.id, s.id`,
      [tokenHash, idleSeconds],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      sessionId: row.session_id,
      email: row.email,
      displayName: row.display_name,
      status: parseStatus(row.status),
      emailVerifiedAt: row.email_verified_at,
      createdAt: row.created_at,
      roles: parseRoles(row.roles ?? []),
      permissions: row.permissions ?? [],
      staff: row.staff,
      mfaEnrolled: row.mfa_enrolled,
      mfaVerifiedAt: row.mfa_verified_at,
      csrfHash: row.csrf_hash,
      expiresAt: row.expires_at,
    };
  }

  async findPendingSession(tokenHash: string, idleSeconds: number): Promise<PendingSession | null> {
    const result = await this.pool.query<{
      id: string;
      user_id: string;
      email: string;
      status: string;
      csrf_hash: string;
      expires_at: Date;
    }>(
      `SELECT s.id, s.user_id, u.email, u.status, s.csrf_hash, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1
         AND s.kind = 'mfa_pending'
         AND s.revoked_at IS NULL
         AND s.expires_at > now()
         AND s.last_seen_at > now() - make_interval(secs => $2::int)`,
      [tokenHash, idleSeconds],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      sessionId: row.id,
      userId: row.user_id,
      email: row.email,
      status: parseStatus(row.status),
      csrfHash: row.csrf_hash,
      expiresAt: row.expires_at,
    };
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId],
    );
  }

  async listSessions(userId: string): Promise<ListedSession[]> {
    const result = await this.pool.query<{
      id: string;
      created_at: Date;
      last_seen_at: Date;
      expires_at: Date;
      ip: string | null;
      user_agent: string | null;
    }>(
      `SELECT id, created_at, last_seen_at, expires_at, ip, user_agent
       FROM sessions
       WHERE user_id = $1 AND kind = 'full' AND revoked_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      ip: row.ip,
      userAgent: row.user_agent,
    }));
  }

  async revokeExact(db: Db, userId: string, sessionId: string): Promise<void> {
    await db.query(
      `UPDATE sessions SET revoked_at = now()
       WHERE id = $2 AND user_id = $1 AND revoked_at IS NULL`,
      [userId, sessionId],
    );
  }

  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE sessions SET revoked_at = now()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [sessionId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async revokeAll(userId: string, db: Db = this.pool): Promise<number> {
    const result = await db.query(
      `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    return result.rowCount ?? 0;
  }

  async revokeOthers(userId: string, sessionId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE sessions
       SET revoked_at = now()
       WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
      [userId, sessionId],
    );
    return result.rowCount ?? 0;
  }

  async clearUnconfirmedFactor(client: pg.PoolClient, userId: string): Promise<void> {
    await client.query(
      `DELETE FROM mfa_recovery_codes
       WHERE factor_id IN (
         SELECT id FROM mfa_factors WHERE user_id = $1 AND confirmed_at IS NULL
       )`,
      [userId],
    );
    await client.query(`DELETE FROM mfa_factors WHERE user_id = $1 AND confirmed_at IS NULL`, [
      userId,
    ]);
  }

  async hasConfirmedFactor(userId: string, db: Db = this.pool): Promise<boolean> {
    const result = await db.query(
      `SELECT 1 FROM mfa_factors
       WHERE user_id = $1 AND confirmed_at IS NOT NULL AND disabled_at IS NULL`,
      [userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async insertFactor(
    client: pg.PoolClient,
    userId: string,
    ciphertext: string,
    nonce: string,
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO mfa_factors (user_id, factor_type, secret_ciphertext, secret_nonce)
       VALUES ($1, 'totp', $2, $3)
       RETURNING id`,
      [userId, ciphertext, nonce],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error('MFA factor insert did not return an id');
    return id;
  }

  async insertRecoveryCodes(
    client: pg.PoolClient,
    userId: string,
    factorId: string,
    codeHashes: readonly string[],
  ): Promise<void> {
    for (const codeHash of codeHashes) {
      await client.query(
        `INSERT INTO mfa_recovery_codes (user_id, factor_id, code_hash) VALUES ($1, $2, $3)`,
        [userId, factorId, codeHash],
      );
    }
  }

  async findPendingFactor(userId: string): Promise<TotpFactor | null> {
    const result = await this.pool.query<{
      id: string;
      secret_ciphertext: string;
      secret_nonce: string;
    }>(
      `SELECT id, secret_ciphertext, secret_nonce
       FROM mfa_factors
       WHERE user_id = $1 AND confirmed_at IS NULL AND disabled_at IS NULL`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { id: row.id, ciphertext: row.secret_ciphertext, nonce: row.secret_nonce };
  }

  async findConfirmedFactor(userId: string, db: Db = this.pool): Promise<TotpFactor | null> {
    const result = await db.query<{
      id: string;
      secret_ciphertext: string;
      secret_nonce: string;
    }>(
      `SELECT id, secret_ciphertext, secret_nonce
       FROM mfa_factors
       WHERE user_id = $1 AND confirmed_at IS NOT NULL AND disabled_at IS NULL`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { id: row.id, ciphertext: row.secret_ciphertext, nonce: row.secret_nonce };
  }

  async confirmFactor(client: pg.PoolClient, userId: string, factorId: string): Promise<boolean> {
    const result = await client.query(
      `UPDATE mfa_factors
       SET confirmed_at = now()
       WHERE id = $1 AND user_id = $2 AND confirmed_at IS NULL AND disabled_at IS NULL`,
      [factorId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async disableFactors(client: pg.PoolClient, userId: string): Promise<void> {
    await client.query(
      `UPDATE mfa_factors SET disabled_at = now() WHERE user_id = $1 AND disabled_at IS NULL`,
      [userId],
    );
    await client.query(
      `UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
  }

  async consumeRecoveryCode(
    client: pg.PoolClient,
    userId: string,
    codeHash: string,
  ): Promise<boolean> {
    const result = await client.query(
      `UPDATE mfa_recovery_codes
       SET used_at = now()
       WHERE code_hash = $2
         AND user_id = $1
         AND used_at IS NULL
         AND factor_id IN (
           SELECT id FROM mfa_factors
           WHERE user_id = $1 AND confirmed_at IS NOT NULL AND disabled_at IS NULL
         )`,
      [userId, codeHash],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async revokeOpenInvitations(client: pg.PoolClient, email: string): Promise<void> {
    await client.query(
      `UPDATE staff_invitations
       SET revoked_at = now()
       WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [email],
    );
  }

  async insertInvitation(
    client: pg.PoolClient,
    input: { email: string; role: RoleCode; tokenHash: string; invitedBy: string; expiresAt: Date },
  ): Promise<void> {
    await client.query(
      `INSERT INTO staff_invitations (email, role_code, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.email, input.role, input.tokenHash, input.invitedBy, input.expiresAt],
    );
  }

  async lockInvitation(client: pg.PoolClient, tokenHash: string): Promise<OpenInvitation | null> {
    const result = await client.query<{
      email: string;
      role_code: string;
      invited_by: string;
    }>(
      `SELECT email, role_code, invited_by
       FROM staff_invitations
       WHERE token_hash = $1
         AND accepted_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > now()
       FOR UPDATE`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      email: row.email,
      roleCode: parseRole(row.role_code),
      invitedBy: row.invited_by,
    };
  }

  async markInvitationAccepted(client: pg.PoolClient, tokenHash: string): Promise<void> {
    await client.query(`UPDATE staff_invitations SET accepted_at = now() WHERE token_hash = $1`, [
      tokenHash,
    ]);
  }

  async markInvitationRevoked(client: pg.PoolClient, tokenHash: string): Promise<void> {
    await client.query(
      `UPDATE staff_invitations SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
  }

  async insertAudit(event: AuditWrite, db: Db = this.pool): Promise<void> {
    await db.query(
      `INSERT INTO authentication_audit_events
         (event_type, actor_user_id, target_user_id, ip, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        event.eventType,
        event.actorUserId,
        event.targetUserId,
        event.ip,
        event.userAgent,
        JSON.stringify(event.metadata),
      ],
    );
  }

  async listAudit(): Promise<AuditEvent[]> {
    const result = await this.pool.query<{
      id: string;
      event_type: string;
      actor_user_id: string | null;
      target_user_id: string | null;
      ip: string | null;
      created_at: Date;
      metadata: unknown;
    }>(
      `SELECT id, event_type, actor_user_id, target_user_id, ip, created_at, metadata
       FROM authentication_audit_events
       ORDER BY created_at DESC
       LIMIT 50`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      actorUserId: row.actor_user_id,
      targetUserId: row.target_user_id,
      ip: row.ip,
      createdAt: row.created_at,
      metadata: asMetadata(row.metadata),
    }));
  }
}

function parseStatus(value: string): AccountStatus {
  const parsed = accountStatusSchema.safeParse(value);
  if (!parsed.success) throw new Error('Stored account status is not in the catalogue');
  return parsed.data;
}

function parseRole(value: string): RoleCode {
  const parsed = roleCodeSchema.safeParse(value);
  if (!parsed.success) throw new Error('Stored role is not in the catalogue');
  return parsed.data;
}

function parseRoles(values: readonly string[]): RoleCode[] {
  return values.map(parseRole);
}

function pgCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

function asMetadata(value: unknown): Record<string, string | number | boolean | null> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof entry === 'string' ||
      typeof entry === 'number' ||
      typeof entry === 'boolean' ||
      entry === null
    ) {
      output[key] = entry;
    }
  }
  return output;
}
