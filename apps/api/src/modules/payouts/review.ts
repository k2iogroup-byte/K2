import type { Pool, PoolClient } from 'pg';

import { latestStatus, PayoutRejected } from './requests.js';

/** Module 02 has no SUPER_ADMIN role. ADMIN is the existing check. The actor stored is SUPER_ADMIN. */
export async function assertPayoutAdmin(pool: Pool, userId: string): Promise<void> {
  const row = await pool.query(
    `SELECT 1 FROM user_roles WHERE user_id = $1 AND role_code = 'ADMIN'`,
    [userId],
  );
  if ((row.rowCount ?? 0) === 0) throw new PayoutRejected('SUPER_ADMIN_REQUIRED');
}

export async function approvePayout(
  pool: Pool,
  requestId: string,
  adminUserId: string,
): Promise<{ accountId: string; amount: string }> {
  await assertPayoutAdmin(pool, adminUserId);
  if ((await latestStatus(pool, requestId)) !== 'UNDER_REVIEW')
    throw new PayoutRejected('NOT_UNDER_REVIEW');
  const request = await pool.query<{
    account_id: string;
    trader_amount: string;
    company_amount: string;
    reserve_amount: string;
  }>(
    `SELECT account_id, trader_amount::text, company_amount::text, reserve_amount::text
     FROM payout_requests WHERE id = $1`,
    [requestId],
  );
  const row = request.rows[0];
  if (!row) throw new PayoutRejected('NOT_FOUND');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const review = await client.query<{ id: string }>(
      `SELECT id FROM human_review_cases WHERE subject_type = 'PAYOUT' AND subject_id = $1`,
      [requestId],
    );
    const caseId = review.rows[0]?.id;
    if (!caseId) throw new PayoutRejected('NOT_UNDER_REVIEW');
    await client.query(
      `INSERT INTO human_review_decisions (case_id, decision, actor_type, actor_user_id)
       VALUES ($1, 'APPROVED', 'SUPER_ADMIN', $2)`,
      [caseId, adminUserId],
    );
    await insertSupplement(client, row.account_id, requestId, 'PAYOUT_TRADER', row.trader_amount);
    await insertSupplement(client, row.account_id, requestId, 'PAYOUT_COMPANY', row.company_amount);
    if (row.reserve_amount !== '0.0000') {
      await insertSupplement(
        client,
        row.account_id,
        requestId,
        'PAYOUT_RESERVE',
        row.reserve_amount,
      );
    }
    await client.query(
      `INSERT INTO sandbox_payouts (payout_request_id, account_id, amount, currency, provider, actor_type)
       VALUES ($1, $2, $3, 'USD', 'sandbox', 'SYSTEM')`,
      [requestId, row.account_id, row.trader_amount],
    );
    await client.query(
      `INSERT INTO payout_audit (request_id, status, actor_type, actor_user_id)
       VALUES ($1, 'APPROVED', 'SUPER_ADMIN', $2)`,
      [requestId, adminUserId],
    );
    await client.query(
      `INSERT INTO payout_audit (request_id, status, actor_type, actor_user_id)
       VALUES ($1, 'PAID', 'SYSTEM', $2)`,
      [requestId, adminUserId],
    );
    await client.query('COMMIT');
    return { accountId: row.account_id, amount: row.trader_amount };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function rejectPayout(
  pool: Pool,
  requestId: string,
  adminUserId: string,
  reason: string,
): Promise<void> {
  await assertPayoutAdmin(pool, adminUserId);
  if (reason.trim() === '') throw new PayoutRejected('REASON_REQUIRED');
  if ((await latestStatus(pool, requestId)) !== 'UNDER_REVIEW')
    throw new PayoutRejected('NOT_UNDER_REVIEW');
  const review = await pool.query<{ id: string }>(
    `SELECT id FROM human_review_cases WHERE subject_type = 'PAYOUT' AND subject_id = $1`,
    [requestId],
  );
  const caseId = review.rows[0]?.id;
  if (!caseId) throw new PayoutRejected('NOT_UNDER_REVIEW');
  await pool.query(
    `INSERT INTO human_review_decisions (case_id, decision, actor_type, actor_user_id, reason)
     VALUES ($1, 'REJECTED', 'SUPER_ADMIN', $2, $3)`,
    [caseId, adminUserId, reason.trim()],
  );
  await pool.query(
    `INSERT INTO payout_audit (request_id, status, actor_type, actor_user_id, reason)
     VALUES ($1, 'REJECTED', 'SUPER_ADMIN', $2, $3)`,
    [requestId, adminUserId, reason.trim()],
  );
}

async function insertSupplement(
  client: PoolClient,
  accountId: string,
  requestId: string,
  entryType: string,
  amount: string,
): Promise<void> {
  await client.query(
    `INSERT INTO journal_supplements (
       account_id, payout_request_id, entry_type, amount, cash_effect, idempotency_key, actor_type
     ) VALUES ($1, $2, $3, $4, false, $5, 'SYSTEM')`,
    [accountId, requestId, entryType, amount, `${entryType}:${requestId}`],
  );
}
