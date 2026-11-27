import type { Pool } from 'pg';

import { drainLedger } from './drain.js';
import { reconcileLedger } from './reconcile.js';
import { accrueSubscriptions } from './subscription.js';

/** Drain, reconcile, then accrue. The timer passes no severity bands. */
export async function runLedgerMaintenance(pool: Pool, now = new Date()): Promise<void> {
  await drainLedger(pool);
  await reconcileLedger(pool);
  await accrueSubscriptions(pool, now);
}
