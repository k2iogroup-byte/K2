import { decimalLessThan, multiplyDecimals, subtractDecimals } from '@k2/shared';
import type { Pool } from 'pg';

import { postedCash } from '../ledger/drain.js';
import { canonicalMoney } from '../ledger/money.js';

const SCALE = 4;
const FIRST_CALENDAR_DAYS = 21;
const LATER_CALENDAR_DAYS = 15;
const TRADING_DAYS = 7;
const TRADER_SHARE = '0.7000';
const COMPANY_SHARE = '0.2000';
/** Applied to the trader share. Provisional, awaiting founder. */
export const MINIMUM_TRADER_PAYOUT = '50.0000';

export type Eligibility = {
  eligible: boolean;
  reason: string | null;
  grossProfit: string | null;
  traderAmount: string | null;
  companyAmount: string | null;
  reserveAmount: string | null;
};

type Gate = {
  accountId: string;
  userId: string;
  initial: string;
  activatedAt: Date | null;
  lastPaidAt: Date | null;
};

export async function isEligible(
  pool: Pool,
  accountId: string,
  now = new Date(),
): Promise<Eligibility> {
  const gate = await loadGate(pool, accountId);
  if (!gate) return blocked('ACCOUNT_NOT_FOUND');
  if (!gate.activatedAt) return blocked('NOT_FUNDED');
  const verified = await pool.query(
    `SELECT 1
     FROM kyc_events AS events
     JOIN kyc_cases AS cases ON cases.id = events.case_id
     WHERE cases.user_id = $1 AND events.status = 'VERIFIED'
     ORDER BY events.seq DESC
     LIMIT 1`,
    [gate.userId],
  );
  if ((verified.rowCount ?? 0) === 0) return blocked('KYC_REQUIRED');
  const windowStart = gate.lastPaidAt ?? gate.activatedAt;
  const requiredDays = gate.lastPaidAt ? LATER_CALENDAR_DAYS : FIRST_CALENDAR_DAYS;
  const elapsed = Math.floor((now.getTime() - windowStart.getTime()) / 86_400_000);
  if (elapsed < requiredDays) return blocked('CALENDAR_DAYS');
  const days = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM risk_trading_days
     WHERE account_id = $1 AND utc_date >= $2::date AND utc_date <= $3::date`,
    [accountId, windowStart.toISOString(), now.toISOString()],
  );
  if (Number(days.rows[0]?.count ?? '0') < TRADING_DAYS) return blocked('TRADING_DAYS');
  const open = await pool.query(
    `SELECT 1 FROM positions WHERE account_id = $1 AND status = 'OPEN' LIMIT 1`,
    [accountId],
  );
  if ((open.rowCount ?? 0) > 0) return blocked('OPEN_POSITION');
  const pending = await pool.query(
    `SELECT 1 FROM ledger_outbox
     WHERE account_id = $1 AND posted_at IS NULL AND event_type IN ('fill', 'commission')
     LIMIT 1`,
    [accountId],
  );
  if ((pending.rowCount ?? 0) > 0) return blocked('LEDGER_UNMATCHED');
  const client = await pool.connect();
  let posted: string;
  try {
    posted = await postedCash(client, accountId);
  } finally {
    client.release();
  }
  const projection = await pool.query<{ cash: string }>(
    `SELECT cash::text FROM simulation_cash_projections WHERE account_id = $1`,
    [accountId],
  );
  const cash = projection.rows[0]?.cash;
  if (!cash || canonicalMoney(cash) !== canonicalMoney(posted)) return blocked('LEDGER_UNMATCHED');
  const closedProfit = subtractDecimals(
    canonicalMoney(posted),
    canonicalMoney(gate.initial),
    SCALE,
  );
  const paid = await cumulativePaidProfit(pool, accountId);
  const profit = subtractDecimals(closedProfit, paid, SCALE);
  if (profit.startsWith('-') || profit === '0.0000') return blocked('NO_NEW_PROFIT');
  const trader = multiplyDecimals(profit, TRADER_SHARE, SCALE, SCALE, SCALE);
  const company = multiplyDecimals(profit, COMPANY_SHARE, SCALE, SCALE, SCALE);
  const reserve = subtractDecimals(subtractDecimals(profit, trader, SCALE), company, SCALE);
  if (reserve.startsWith('-')) return blocked('BELOW_MINIMUM');
  if (decimalLessThan(trader, MINIMUM_TRADER_PAYOUT, SCALE)) return blocked('BELOW_MINIMUM');
  return {
    eligible: true,
    reason: null,
    grossProfit: profit,
    traderAmount: trader,
    companyAmount: company,
    reserveAmount: reserve === '0.0000' ? null : reserve,
  };
}

export async function nextPayoutDate(
  pool: Pool,
  accountId: string,
  now = new Date(),
): Promise<string | null> {
  const gate = await loadGate(pool, accountId);
  if (!gate?.activatedAt) return null;
  const windowStart = gate.lastPaidAt ?? gate.activatedAt;
  const requiredDays = gate.lastPaidAt ? LATER_CALENDAR_DAYS : FIRST_CALENDAR_DAYS;
  const due = new Date(windowStart.getTime() + requiredDays * 86_400_000);
  if (due.getTime() <= now.getTime()) return null;
  return due.toISOString();
}

async function loadGate(pool: Pool, accountId: string): Promise<Gate | null> {
  const row = await pool.query<{
    user_id: string;
    initial: string;
    activated_at: Date | null;
    last_paid_at: Date | null;
  }>(
    `SELECT accounts.user_id, accounts.initial_capital::text AS initial, funded.activated_at,
            (
              SELECT audit.created_at
              FROM payout_audit AS audit
              JOIN payout_requests AS requests ON requests.id = audit.request_id
              WHERE requests.account_id = accounts.id AND audit.status = 'PAID'
              ORDER BY audit.seq DESC
              LIMIT 1
            ) AS last_paid_at
     FROM trading_accounts AS accounts
     LEFT JOIN funded_activations AS funded ON funded.account_id = accounts.id
     WHERE accounts.id = $1`,
    [accountId],
  );
  const found = row.rows[0];
  if (!found) return null;
  return {
    accountId,
    userId: found.user_id,
    initial: found.initial,
    activatedAt: found.activated_at,
    lastPaidAt: found.last_paid_at,
  };
}

async function cumulativePaidProfit(pool: Pool, accountId: string): Promise<string> {
  const row = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(requests.gross_profit), 0)::text AS total
     FROM payout_requests AS requests
     JOIN LATERAL (
       SELECT status FROM payout_audit
       WHERE request_id = requests.id
       ORDER BY seq DESC
       LIMIT 1
     ) AS latest ON true
     WHERE requests.account_id = $1
       AND latest.status IN ('APPROVED', 'PAID')`,
    [accountId],
  );
  return canonicalMoney(row.rows[0]?.total ?? '0');
}

function blocked(reason: string): Eligibility {
  return {
    eligible: false,
    reason,
    grossProfit: null,
    traderAmount: null,
    companyAmount: null,
    reserveAmount: null,
  };
}
