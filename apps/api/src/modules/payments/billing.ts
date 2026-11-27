import type { Pool } from 'pg';

import type { PaymentProvider } from './provider.js';

/** No configured day count means immediate human review. Never invents 3 or 7. */
export function configuredGraceDays(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  if (!/^[1-9]\d{0,2}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

export async function collectSubscription(
  pool: Pool,
  provider: PaymentProvider,
  subscriptionChargeId: string,
  simulate: 'succeed' | 'fail',
): Promise<{ providerRef: string }> {
  const charge = await pool.query<{ account_id: string; amount: string }>(
    `SELECT account_id, amount::text FROM subscription_charges WHERE id = $1`,
    [subscriptionChargeId],
  );
  const row = charge.rows[0];
  if (!row) throw new Error('subscription charge not found');
  const account = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM trading_accounts WHERE id = $1`,
    [row.account_id],
  );
  const userId = account.rows[0]?.user_id;
  if (!userId) throw new Error('subscription account not found');
  const created = await provider.createCharge({
    amount: row.amount,
    currency: 'USD',
    metadata: { purpose: 'SUBSCRIPTION', simulate },
  });
  await pool.query(
    `INSERT INTO payment_charges (
       user_id, purpose, amount, currency, provider, provider_ref, subscription_charge_id,
       idempotency_key, actor_type
     ) VALUES ($1, 'SUBSCRIPTION', $2, 'USD', 'sandbox', $3, $4, $5, 'SYSTEM')
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      userId,
      row.amount,
      created.providerRef,
      subscriptionChargeId,
      `subpay:${subscriptionChargeId}:${simulate}`,
    ],
  );
  return { providerRef: created.providerRef };
}

export async function recordSubscriptionOutcome(
  pool: Pool,
  input: {
    subscriptionChargeId: string;
    paymentEventId: string;
    outcome: 'SUCCEEDED' | 'FAILED';
    now: Date;
    graceDays: number | null;
  },
): Promise<void> {
  if (input.outcome === 'SUCCEEDED') {
    await pool.query(
      `INSERT INTO subscription_receipts (subscription_charge_id, payment_event_id, actor_type)
       VALUES ($1, $2, 'SYSTEM')
       ON CONFLICT (subscription_charge_id) DO NOTHING`,
      [input.subscriptionChargeId, input.paymentEventId],
    );
    return;
  }
  const account = await pool.query<{ account_id: string; state: string }>(
    `SELECT account_id, (
       SELECT state FROM trading_accounts WHERE id = subscription_charges.account_id
     ) AS state
     FROM subscription_charges WHERE id = $1`,
    [input.subscriptionChargeId],
  );
  const row = account.rows[0];
  if (!row) return;
  const before = row.state;
  if (input.graceDays === null) {
    await openReview(pool, input.subscriptionChargeId, row.account_id);
  } else {
    const until = new Date(input.now.getTime() + input.graceDays * 86_400_000);
    await pool.query(
      `INSERT INTO subscription_grace (subscription_charge_id, account_id, grace_until, actor_type)
       VALUES ($1, $2, $3, 'SYSTEM')
       ON CONFLICT (subscription_charge_id) DO NOTHING`,
      [input.subscriptionChargeId, row.account_id, until],
    );
  }
  const after = await pool.query<{ state: string }>(
    `SELECT state FROM trading_accounts WHERE id = $1`,
    [row.account_id],
  );
  if (after.rows[0]?.state !== before) {
    throw new Error('subscription collection changed the account state');
  }
}

export async function expireSubscriptionGrace(pool: Pool, now: Date): Promise<number> {
  const due = await pool.query<{ id: string; account_id: string }>(
    `SELECT subscription_charge_id AS id, account_id
     FROM subscription_grace
     WHERE grace_until <= $1`,
    [now],
  );
  let opened = 0;
  for (const row of due.rows) {
    const inserted = await openReview(pool, row.id, row.account_id);
    if (inserted) opened += 1;
  }
  return opened;
}

async function openReview(
  pool: Pool,
  subscriptionChargeId: string,
  accountId: string,
): Promise<boolean> {
  const row = await pool.query(
    `INSERT INTO human_review_items (subject_type, subject_id, account_id, actor_type)
     VALUES ('PAYMENT_GRACE_EXPIRY', $1, $2, 'SYSTEM')
     ON CONFLICT (subject_type, subject_id) DO NOTHING
     RETURNING id`,
    [subscriptionChargeId, accountId],
  );
  return (row.rowCount ?? 0) > 0;
}
