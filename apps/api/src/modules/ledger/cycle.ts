import type { Pool } from 'pg';

import { drainLedger } from './drain.js';
import { reconcileLedger } from './reconcile.js';

/** Drain and reconcile. Subscription accrual is added beside this call. */
export async function runLedgerMaintenance(pool: Pool): Promise<void> {
  await drainLedger(pool);
  await reconcileLedger(pool);
}
