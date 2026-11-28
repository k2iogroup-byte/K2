import type { Pool } from 'pg';

import { expireSubscriptionGrace } from '../payments/billing.js';
import { drainLedger } from './drain.js';
import { reconcileLedger } from './reconcile.js';
import { accrueSubscriptions } from './subscription.js';

/** Drain, reconcile, accrue, then open reviews whose grace has ended. */
export async function runLedgerMaintenance(
  pool: Pool,
  now = new Date(),
  staleAfterSeconds?: number,
): Promise<void> {
  await drainLedger(pool);
  await reconcileLedger(pool, { now, staleAfterSeconds });
  await accrueSubscriptions(pool, now);
  await expireSubscriptionGrace(pool, now);
}
