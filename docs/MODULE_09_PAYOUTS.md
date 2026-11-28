# Module 09 — Payouts

**Status:** Implemented 2026-11-27. No real payout rail. An approved payout is recorded for the sandbox only. No Funded account is created.

## Eligibility

`isEligible(accountId)` returns true or false and a reason. A request is rejected when any of these is true:

- There is no `funded_activations` row. Module 06 records `PASSED` and does not open a Funded account. This module does not create one and does not change `trading_accounts`. The activation row is an explicit source tests can insert. Until a later module writes it, there is no end-to-end funded path.
- Fewer than 21 calendar days have passed since that activation. A later payout uses 15 calendar days since the last `PAID` payout. That start point is provisional.
- Fewer than 7 `risk_trading_days` fall inside that window.
- Any position is `OPEN`.
- Posted cash and the simulation cash projection differ, or a fill or commission is still unposted. The comparison uses the Module 07 sum.
- Distributable profit is posted cash minus `initial_capital` minus the gross of requests whose latest status is `APPROVED` or `PAID`. Each request counts once. `REJECTED` requests are not counted. A distributable amount of zero or less is `NO_NEW_PROFIT`. The 70/20/10 split uses that remainder. The $50 minimum is applied to the trader share. That reading is provisional. The drawdown floor stays 0.92 times `initial_capital`.
- The user has no `VERIFIED` KYC event. This is applied to every request. The "first payout only" reading is provisional.

## Request and review

`POST /payouts` locks the account row, rejects a second open request, then creates a `PENDING` request or returns 400 with the reason. A system step moves it to `UNDER_REVIEW` and appends one `human_review_cases` row with subject `PAYOUT`. The queue lists those rows.

Approve and reject require the existing `ADMIN` role. Module 02 has no `SUPER_ADMIN` role, so this module does not add one. The audit actor is recorded as `SUPER_ADMIN`. Reject requires a non-empty reason.

Approval appends three `journal_supplements` rows (`PAYOUT_TRADER`, `PAYOUT_COMPANY`, `PAYOUT_RESERVE`) with `cash_effect` false, then one `sandbox_payouts` row, then `PAID`. Posted cash and the simulation projection are not reduced. `journal_entries.entry_type` cannot gain a payout type without altering migration 0014, so the supplement table is the additive journal. Leaving cash unchanged is provisional and reversible.

## Human review

`human_review_items.subject_type` is fixed to `PAYMENT_GRACE_EXPIRY` by migration 0015. Widening that check would be an `ALTER`. The generic queue is the new append-only `human_review_cases` table (`PAYMENT_GRACE_EXPIRY`, `PAYOUT`, `KYC`) plus `human_review_decisions`. Payment grace writes both tables. Payout and KYC use the new table only.

## Dashboard

`payoutDashboard` is read-only: eligibility, the next date when the calendar window is still short, and the request history.
