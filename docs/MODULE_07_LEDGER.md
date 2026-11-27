# Module 07 — Ledger

**Status:** Contract recorded 2026-11-27. The journal is the cash record for the simulation. It does not trade, collect money, or talk to a broker. Production fills stay off.

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

An account with an unposted `fill` or `commission` row is skipped for that pass. Draining lag is not a mismatch.

A mismatch appends `mismatch_log` and, if the account is not already frozen, `ledger_freezes`. The log is not deleted. `ledger_anomalies` is a view over that log for a later oversight reader. Columns: severity, timestamp, account_id, expected_amount, actual_amount, source module `M07`, kind `CASH_MISMATCH`, actor_type. No oversight service is built here.

Severity values are `INFO`, `WARNING`, and `CRITICAL`. With no configured bands, every exact mismatch is `CRITICAL`. Numeric bands are not built into production. A caller may pass absolute warning and critical bounds; until a founder sets them, the timer passes none.

A freeze rejects a new buy inside `RiskEngineAuthorizer`, in the same transaction, with `LEDGER_FROZEN`. Risk-reducing sells return before that authorizer, so a close, stop, or forced liquidation still runs. `trading-service.ts` is not edited. The server process still uses the fail-closed authorizer for ordinary API buys.

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
- Severity bands have no production numbers. Every exact mismatch is `CRITICAL`.
- Accrual stops when the account is `FAILED` or `PASSED`.
