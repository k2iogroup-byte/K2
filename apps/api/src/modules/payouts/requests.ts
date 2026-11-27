import type { Pool } from 'pg';

import { isEligible, nextPayoutDate } from './eligibility.js';

export class PayoutRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'PayoutRejected';
  }
}

export async function requestPayout(
  pool: Pool,
  accountId: string,
  now = new Date(),
): Promise<{ requestId: string; status: 'PENDING'; traderAmount: string }> {
  const open = await pool.query(
    `SELECT 1
     FROM payout_requests AS requests
     JOIN LATERAL (
       SELECT status FROM payout_audit WHERE request_id = requests.id ORDER BY seq DESC LIMIT 1
     ) AS latest ON true
     WHERE requests.account_id = $1 AND latest.status IN ('PENDING', 'UNDER_REVIEW', 'APPROVED')
     LIMIT 1`,
    [accountId],
  );
  if ((open.rowCount ?? 0) > 0) throw new PayoutRejected('ALREADY_OPEN');
  const decision = await isEligible(pool, accountId, now);
  if (
    !decision.eligible ||
    !decision.grossProfit ||
    !decision.traderAmount ||
    !decision.companyAmount
  ) {
    throw new PayoutRejected(decision.reason ?? 'NOT_ELIGIBLE');
  }
  const reserve = decision.reserveAmount ?? '0.0000';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = await client.query<{ id: string }>(
      `INSERT INTO payout_requests (
         account_id, gross_profit, trader_amount, company_amount, reserve_amount, actor_type
       ) VALUES ($1, $2, $3, $4, $5, 'SYSTEM')
       RETURNING id`,
      [accountId, decision.grossProfit, decision.traderAmount, decision.companyAmount, reserve],
    );
    const requestId = created.rows[0]?.id;
    if (!requestId) throw new Error('payout request was not stored');
    await client.query(
      `INSERT INTO payout_audit (request_id, status, actor_type) VALUES ($1, 'PENDING', 'SYSTEM')`,
      [requestId],
    );
    await client.query('COMMIT');
    return { requestId, status: 'PENDING', traderAmount: decision.traderAmount };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function queuePayoutReview(pool: Pool, requestId: string): Promise<void> {
  const current = await latestStatus(pool, requestId);
  if (current !== 'PENDING') throw new PayoutRejected('NOT_PENDING');
  const request = await pool.query<{ account_id: string }>(
    `SELECT account_id FROM payout_requests WHERE id = $1`,
    [requestId],
  );
  const accountId = request.rows[0]?.account_id;
  if (!accountId) throw new PayoutRejected('NOT_FOUND');
  await pool.query(
    `INSERT INTO payout_audit (request_id, status, actor_type) VALUES ($1, 'UNDER_REVIEW', 'SYSTEM')`,
    [requestId],
  );
  await pool.query(
    `INSERT INTO human_review_cases (subject_type, subject_id, account_id, actor_type)
     VALUES ('PAYOUT', $1, $2, 'SYSTEM')
     ON CONFLICT (subject_type, subject_id) DO NOTHING`,
    [requestId, accountId],
  );
}

export async function reviewQueue(pool: Pool): Promise<{ requestId: string; accountId: string }[]> {
  const rows = await pool.query<{ request_id: string; account_id: string }>(
    `SELECT requests.id AS request_id, requests.account_id
     FROM human_review_cases AS cases
     JOIN payout_requests AS requests ON requests.id = cases.subject_id
     JOIN LATERAL (
       SELECT status FROM payout_audit WHERE request_id = requests.id ORDER BY seq DESC LIMIT 1
     ) AS latest ON true
     WHERE cases.subject_type = 'PAYOUT' AND latest.status = 'UNDER_REVIEW'`,
  );
  return rows.rows.map((row) => ({ requestId: row.request_id, accountId: row.account_id }));
}

export async function latestStatus(pool: Pool, requestId: string): Promise<string | null> {
  const row = await pool.query<{ status: string }>(
    `SELECT status FROM payout_audit WHERE request_id = $1 ORDER BY seq DESC LIMIT 1`,
    [requestId],
  );
  return row.rows[0]?.status ?? null;
}

export async function payoutDashboard(pool: Pool, accountId: string, now = new Date()) {
  const decision = await isEligible(pool, accountId, now);
  const next = await nextPayoutDate(pool, accountId, now);
  const history = await pool.query<{
    id: string;
    status: string;
    trader_amount: string;
    created_at: Date;
  }>(
    `SELECT requests.id, latest.status, requests.trader_amount::text, requests.created_at
     FROM payout_requests AS requests
     JOIN LATERAL (
       SELECT status FROM payout_audit WHERE request_id = requests.id ORDER BY seq DESC LIMIT 1
     ) AS latest ON true
     WHERE requests.account_id = $1
     ORDER BY requests.created_at`,
    [accountId],
  );
  return {
    eligible: decision.eligible,
    reason: decision.reason,
    nextPayoutAt: next,
    history: history.rows.map((row) => ({
      id: row.id,
      status: row.status,
      traderAmount: row.trader_amount,
      createdAt: row.created_at.toISOString(),
    })),
  };
}
