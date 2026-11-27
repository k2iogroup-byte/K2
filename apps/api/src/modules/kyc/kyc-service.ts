import type { Pool } from 'pg';

import type { KycProvider } from './provider.js';
import { SandboxKycProvider } from './sandbox.js';

export class KycRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'KycRejected';
  }
}

export type KycStatus = 'NOT_STARTED' | 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED';

const provider: KycProvider = new SandboxKycProvider();

export async function submitDocuments(
  pool: Pool,
  userId: string,
  documentIds: readonly string[],
): Promise<{ status: 'PENDING' }> {
  if (documentIds.length === 0 || documentIds.some((id) => id.trim() === '')) {
    throw new KycRejected('DOCUMENT_REFERENCE_REQUIRED');
  }
  const existing = await pool.query<{ id: string }>(`SELECT id FROM kyc_cases WHERE user_id = $1`, [
    userId,
  ]);
  let caseId = existing.rows[0]?.id;
  if (!caseId) {
    const created = await provider.submitDocuments(documentIds);
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO kyc_cases (user_id, provider, provider_ref, actor_type)
       VALUES ($1, 'sandbox', $2, 'SYSTEM')
       RETURNING id`,
      [userId, created.providerRef],
    );
    caseId = inserted.rows[0]?.id;
  }
  if (!caseId) throw new Error('kyc case was not stored');
  for (const documentId of documentIds) {
    await pool.query(
      `INSERT INTO kyc_document_refs (case_id, provider_document_id, actor_type)
       VALUES ($1, $2, 'SYSTEM')`,
      [caseId, documentId.trim()],
    );
  }
  const current = await checkStatus(pool, userId);
  if (current !== 'NOT_STARTED') throw new KycRejected('ALREADY_SUBMITTED');
  await pool.query(
    `INSERT INTO kyc_events (case_id, status, actor_type) VALUES ($1, 'PENDING', 'SYSTEM')`,
    [caseId],
  );
  return { status: 'PENDING' };
}

export async function checkStatus(pool: Pool, userId: string): Promise<KycStatus> {
  const row = await pool.query<{ status: string }>(
    `SELECT events.status
     FROM kyc_events AS events
     JOIN kyc_cases AS cases ON cases.id = events.case_id
     WHERE cases.user_id = $1
     ORDER BY events.seq DESC
     LIMIT 1`,
    [userId],
  );
  const status = row.rows[0]?.status;
  if (
    status === 'PENDING' ||
    status === 'UNDER_REVIEW' ||
    status === 'VERIFIED' ||
    status === 'REJECTED'
  ) {
    return status;
  }
  return 'NOT_STARTED';
}

export async function applyKycWebhook(
  pool: Pool,
  payload: string,
  signature: string,
): Promise<'rejected' | 'accepted'> {
  const checked = provider.verifyWebhook(payload, signature);
  if (!checked.ok) return 'rejected';
  const body = JSON.parse(checked.body) as { providerRef?: string; status?: string };
  if (!body.providerRef || body.status !== 'UNDER_REVIEW') return 'rejected';
  const found = await pool.query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM kyc_cases WHERE provider_ref = $1`,
    [body.providerRef],
  );
  const row = found.rows[0];
  if (!row) return 'rejected';
  if ((await checkStatus(pool, row.user_id)) !== 'PENDING') return 'accepted';
  await pool.query(
    `INSERT INTO kyc_events (case_id, status, actor_type) VALUES ($1, 'UNDER_REVIEW', 'SYSTEM')`,
    [row.id],
  );
  await pool.query(
    `INSERT INTO human_review_cases (subject_type, subject_id, actor_type)
     VALUES ('KYC', $1, 'SYSTEM')
     ON CONFLICT (subject_type, subject_id) DO NOTHING`,
    [row.id],
  );
  return 'accepted';
}

export async function decideKyc(
  pool: Pool,
  userId: string,
  adminUserId: string,
  decision: 'VERIFIED' | 'REJECTED',
  reason: string,
): Promise<void> {
  const role = await pool.query(
    `SELECT 1 FROM user_roles WHERE user_id = $1 AND role_code = 'ADMIN'`,
    [adminUserId],
  );
  if ((role.rowCount ?? 0) === 0) throw new KycRejected('SUPER_ADMIN_REQUIRED');
  if (decision === 'REJECTED' && reason.trim() === '') throw new KycRejected('REASON_REQUIRED');
  if ((await checkStatus(pool, userId)) !== 'UNDER_REVIEW')
    throw new KycRejected('NOT_UNDER_REVIEW');
  const found = await pool.query<{ id: string }>(`SELECT id FROM kyc_cases WHERE user_id = $1`, [
    userId,
  ]);
  const caseId = found.rows[0]?.id;
  if (!caseId) throw new KycRejected('NOT_UNDER_REVIEW');
  const review = await pool.query<{ id: string }>(
    `SELECT id FROM human_review_cases WHERE subject_type = 'KYC' AND subject_id = $1`,
    [caseId],
  );
  const reviewId = review.rows[0]?.id;
  if (!reviewId) throw new KycRejected('NOT_UNDER_REVIEW');
  await pool.query(
    `INSERT INTO human_review_decisions (case_id, decision, actor_type, actor_user_id, reason)
     VALUES ($1, $2, 'SUPER_ADMIN', $3, $4)`,
    [reviewId, decision, adminUserId, decision === 'REJECTED' ? reason.trim() : null],
  );
  await pool.query(
    `INSERT INTO kyc_events (case_id, status, actor_type, reason) VALUES ($1, $2, 'SUPER_ADMIN', $3)`,
    [caseId, decision, decision === 'REJECTED' ? reason.trim() : null],
  );
}
