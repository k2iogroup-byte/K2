# Module 07 — Ledger

**Status:** Implemented 2026-11-27 for the simulation journal. It does not trade, collect money, or talk to a broker. Production fills stay off.

## What Module 05 already writes

`ledger_outbox` is filled by `trading-service.ts` after each execution. Module 07 consumes those rows and does not change that writer.

| event_type   | idempotency_key             | amount                                         |
| ------------ | --------------------------- | ---------------------------------------------- |
| `fill`       | `fill:${executionId}`       | unsigned notional, USD                         |
| `commission` | `commission:${executionId}` | opening fee, only when it is greater than zero |

`payload` is empty. Buy or sell is read from `orders.side` through `executions`. `posted_at` is left null. Module 05 never updates it. The table has no append-only trigger, so Module 07 may set `posted_at` once.

The cash projection starts at `initial_capital`. That seed is not an outbox row. The drainer writes one `OPENING` journal row, key `opening:${accountId}`, so the journal sum can match the projection.

## Journal

`posted_cash_balance` is the sum of journal rows whose `cash_effect` is true. There is no second balance table. A stored balance would need updates and could drift from an append-only journal.

Signs, scale 4: opening is positive initial capital, a buy fill is a negative notional, a sell fill is a positive notional, commission is negative. `SUBSCRIPTION` has `cash_effect` false, so it does not change the sum or equity.

A repeated outbox key inserts nothing. The insert uses `ON CONFLICT (idempotency_key) DO NOTHING`. The drainer runs on the trading-lock holder, not inside the fill. Rows with no execution or no side stay unposted and do not freeze the account.

## Reconciliation

Compare `simulation_cash_projections.cash` with the cash-journal sum. Both are scale 4. They must be exactly equal. Reserved cash is not part of the comparison.

An account with an unposted `fill` or `commission` row is skipped for that pass. Draining lag is not a mismatch. The maintenance cycle drains first, then reconciles. A row still unposted after `LEDGER_STALE_OUTBOX_SECONDS` (provisional default 300) appends one `STALE_OUTBOX` warning. It does not freeze. The same outbox id is not warned again.

A cash gap below `0.0100` appends `OBSERVED` / `WARNING` and does not freeze. The next cycle escalates a gap that is still not zero to `ESCALATED` / `CRITICAL` and freezes. A gap of `0.0100` or more is `CRITICAL` and freezes on the first cycle. A gap that disappears appends `RESOLVED` and does not freeze. These rows are append-only in `mismatch_events`. `ledger_anomalies` remains the view over `mismatch_log`. `ledger_anomaly_current` is the view of the latest cash event per account.

A freeze rejects a new buy inside `RiskEngineAuthorizer`, in the same transaction, with `LEDGER_FROZEN`. Risk-reducing sells return before that authorizer, so a close, stop, or forced liquidation still runs. `trading-service.ts` is not edited.

A freeze is lifted only by `liftLedgerFreeze`, which appends `ledger_freeze_lifts`. Matching balances do not lift it.

## Subscription accounting

One dollar per $1,000 of `initial_capital`, from `MIN(executions.executed_at)`, then every 30 times 24 hours. The charge is a `SUBSCRIPTION` journal row and a `subscription_charges` row. It is not cash and does not move equity. Accrual runs only while the account is `ACTIVE`. `FAILED` and `PASSED` stop it. This stop is provisional.

Module 07 does not collect money, does not start a grace period, and does not change the account state. A later payments module can read the accrual. Grace expiry belongs in that module, as a review row, not as `FAILED` or `PAUSED`.

## Reversal

`postReversal` appends the opposite signed amount. The original row stays. The caller passes `actor_type`. Current product calls pass `SYSTEM`. `AI_AGENT` and `SUPER_ADMIN` exist so a later operations module can call the same function. There is no UI.

## Actor

`journal_entries`, `mismatch_log`, `ledger_freezes`, `ledger_freeze_lifts`, and `subscription_charges` store `actor_type`: `SYSTEM`, `AI_AGENT`, or `SUPER_ADMIN`. Module 07 writes `SYSTEM` except when reversal is given another actor.

## Timer

The lock holder runs drain, reconcile, and accrual every 60 seconds beside the Module 06 review. No Redis, Kafka, or new service. Tests call the functions directly.

## Provisional choices

Recorded in the decisions log as provisional, awaiting the founder:

- A freeze lifts only through `liftLedgerFreeze`.
- A stuck outbox warning uses `LEDGER_STALE_OUTBOX_SECONDS`, provisional default 300.
- Accrual stops when the account is `FAILED` or `PASSED`.
