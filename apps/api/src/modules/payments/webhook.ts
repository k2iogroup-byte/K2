import type { Pool } from 'pg';

import type { AccountService } from '../accounts/account-service.js';
import { recordSubscriptionOutcome } from './billing.js';
import type { PaymentProvider } from './provider.js';
import { provisionPaidChallenge } from './purchase.js';

export type WebhookResult = 'rejected' | 'duplicate' | 'accepted';

type WebhookBody = {
  eventId?: string;
  providerRef?: string;
  outcome?: string;
};

/** Rejects a bad signature. A repeated provider event id is stored once. */
export async function applyWebhook(
  pool: Pool,
  provider: PaymentProvider,
  accounts: AccountService,
  payload: string,
  signature: string,
  now: Date,
  graceDays: number | null,
): Promise<WebhookResult> {
  const checked = provider.verifyWebhook(payload, signature);
  if (!checked.ok) return 'rejected';
  const body = JSON.parse(checked.body) as WebhookBody;
  if (
    !body.eventId ||
    !body.providerRef ||
    (body.outcome !== 'SUCCEEDED' && body.outcome !== 'FAILED')
  ) {
    return 'rejected';
  }
  const charge = await pool.query<{
    id: string;
    user_id: string;
    purpose: string;
    amount: string;
    price_version_id: string | null;
    subscription_charge_id: string | null;
  }>(
    `SELECT id, user_id, purpose, amount::text, price_version_id, subscription_charge_id
     FROM payment_charges WHERE provider_ref = $1`,
    [body.providerRef],
  );
  const row = charge.rows[0];
  if (!row) return 'rejected';
  const client = await pool.connect();
  let eventId: string | undefined;
  try {
    await client.query('BEGIN');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO payment_events (charge_id, provider_event_id, outcome, actor_type)
       VALUES ($1, $2, $3, 'SYSTEM')
       ON CONFLICT (provider_event_id) DO NOTHING
       RETURNING id`,
      [row.id, body.eventId, body.outcome],
    );
    eventId = inserted.rows[0]?.id;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (!eventId) return 'duplicate';
  if (
    body.outcome === 'SUCCEEDED' &&
    row.purpose === 'CHALLENGE_PURCHASE' &&
    row.price_version_id
  ) {
    await provisionPaidChallenge(accounts, {
      userId: row.user_id,
      priceVersionId: row.price_version_id,
      amount: row.amount,
      eventId: body.eventId,
      verifiedAt: now.toISOString(),
    });
  }
  if (row.purpose === 'SUBSCRIPTION' && row.subscription_charge_id) {
    await recordSubscriptionOutcome(pool, {
      subscriptionChargeId: row.subscription_charge_id,
      paymentEventId: eventId,
      outcome: body.outcome,
      now,
      graceDays,
    });
  }
  return 'accepted';
}
