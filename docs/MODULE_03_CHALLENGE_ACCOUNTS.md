# Module 03 — Challenge and account management

**Status:** Implemented on `module-03-challenge-accounts`. Not deployed. No Vercel or Railway resources were created. No payment provider and no ledger are included.

This document is the implementation record. The proposed catalogue and account sketches in [API_SPECIFICATION.md](./API_SPECIFICATION.md) and [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) stay proposed. Where this module differs, this file is the implemented contract.

## What was inspected

`main` was `e3bed92e3fc653f88b68124a223876397a647ab1`, which contains Module 01 and Module 02. Module 02 sessions, CSRF, RBAC, and staff MFA are reused. `requireRead`, `requireWrite`, and `requireStaffAccess` are the same functions the auth routes use. No parallel user table or session cookie was created.

## Implemented

| Area                       | Behavior                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalogue                  | Five confirmed products are seed data: 10000/129, 25000/250, 50000/399, 100000/699, 200000/1200, currency USD. `GET /catalogue/challenges` returns active products and the open price only.                                                                                                                                       |
| Price history              | A new price closes the open version by setting `valid_to` once. The price amount of an existing version cannot be updated. An account stores `price_version_id` and does not follow a later price.                                                                                                                                |
| Activation                 | Staff can activate or deactivate a product. The change is an append-only event. Existing accounts are not rewritten. A new purchase is accepted only when the product was active at `verifiedAt`.                                                                                                                                 |
| Future products            | `POST /staff/catalogue/products` inserts a size and opening price as data. Sizes `5000` and `300000` are rejected by the database. Sizes above `1000000` are rejected. No unconfirmed size is seeded.                                                                                                                             |
| Rule sets                  | Version 1 of `CHALLENGE_EVALUATION` stores the confirmed Stage 1 and Stage 2 numbers and stores the unresolved parameters with a null value. Versions are append-only. A later version does not update accounts already provisioned.                                                                                              |
| Unresolved parameters      | `drawdown_basis`, `daily_loss_reference`, `daily_reset_at`, `trading_day_definition`, `profit_target_basis`, `duration_clock`, `stage_transition`, `breach_consequence`, `commission_market_scope`, `subscription_collection`, and `activation_condition` are `UNRESOLVED`. The publish endpoint refuses to assign them a number. |
| Provisioning               | `AccountService.provisionFromVerifiedPurchase` accepts only `sourceSystem: "M-08"` evidence whose amount and currency match the price version that was applicable at `verifiedAt`. The same idempotency key returns the same account. There is no HTTP checkout, webhook, or "mark paid" route.                                   |
| Lifecycle                  | States are `PROVISIONED`, `ACTIVE`, `PASSED`, `FAILED`, `EXPIRED`, `SUSPENDED`, `UNDER_REVIEW`, and `CLOSED`. Every change inserts an append-only transition with reason, actor, and timestamp before the state column changes.                                                                                                   |
| Administrative transitions | An MFA-satisfied `ADMIN` may suspend, place under review, resume to the previous state, or close. Resume does not activate a provisioned account.                                                                                                                                                                                 |
| Blocked outcomes           | Requests to move an account to `ACTIVE`, `PASSED`, `FAILED`, or `EXPIRED` return `UNRESOLVED_RULE` and do not read rule numbers. The rejection is audited.                                                                                                                                                                        |
| Ownership                  | `GET /accounts` returns only the signed-in user's accounts. Another user's account id is HTTP 404. Staff use `/staff/users/:id/accounts` and `/staff/accounts/:id`.                                                                                                                                                               |
| Audit                      | Catalogue changes, provisioning, transitions, and rejected unresolved transitions are appended to `challenge_audit_events`.                                                                                                                                                                                                       |

Confirmed numbers, including commission, swap, and the subscription rate, are stored as data. Nothing in this module calculates profit, loss, drawdown, a trading day, a pass, or a failure from those numbers.

## Integration contracts

`apps/api/src/modules/accounts/integration-ports.ts` defines the boundary:

- `VerifiedPurchaseEvidence` is the only purchase input. M-08 must verify the provider event before calling `provisionFromVerifiedPurchase`. M-03 does not contact a payment provider and does not invent a successful payment.
- `postChallengeFee` always throws `DEPENDENCY_UNAVAILABLE`. M-07 does not exist. No journal, balance, or payment-status column is written.
- `collectSubscription` always throws `DEPENDENCY_UNAVAILABLE`. The subscription rate is stored on the rule set and is not billed.

`purchase_evidence_references` stores the evidence amount so a replay can be compared with the price version. It is not a balance and it is not a payment row. The external reference is not returned by the API.

## Authorisation

New permissions, granted in migration `0003`:

| Permission            | Who has it                                                                             |
| --------------------- | -------------------------------------------------------------------------------------- |
| `accounts.read`       | Every role. Traders see only their own accounts. Staff routes still require staff MFA. |
| `accounts.transition` | `ADMIN` only                                                                           |
| `catalogue.manage`    | `ADMIN` only                                                                           |

This matches the Module 02 engineering default that staff mutations belong to `ADMIN` until the founder widens another role. The proposed API rows that name `RISK` and `COMPLIANCE` for suspension, and `MANAGEMENT` for rule approval, are not granted.

State-changing catalogue and transition routes require the Module 02 CSRF pair and an `idempotency-key` header of 16 to 80 URL-safe characters. A repeated key with the same command returns the original result. The same key with a different command returns HTTP 409.

## Engineering defaults

These are not founder business rules.

| Control              | Value                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Currency             | `USD` only, because the confirmed prices are dollar amounts. Taxes, VAT, regional prices, discounts, and refunds stay unresolved (BR-108).                                                             |
| Catalogue epoch      | Seed rows use `2026-01-01T00:00:00Z`. That is the row's `valid_from`, not a launch date.                                                                                                               |
| Purchase clock skew  | Evidence more than five minutes ahead of the API clock is rejected.                                                                                                                                    |
| Reason text          | 8 to 500 characters, letters, numbers, and a small punctuation set.                                                                                                                                    |
| Numeric input bounds | Percent and rate values must be from 0 to 100. Day counts must be from 0 to 10000. USD subscription inputs must be from 0 to 10000. These ceilings stop typos. They are not confirmed business maxima. |
| Stage column         | Inserts must be `STAGE_1`. Stage 2 parameters exist on the rule set. A Stage 2 account is not created.                                                                                                 |
| Paths                | No `/v1` prefix, consistent with Module 02. The proposed `/v1/...` rows were not built.                                                                                                                |

## Not implemented

- Checkout, provider webhooks, refunds, chargebacks, and any route that marks an account paid.
- A financial ledger, account balance, equity, or subscription charge.
- Pass, fail, expiry, drawdown, trading-day counting, and profit-target evaluation.
- Activation. No founder document defines the condition that moves `PROVISIONED` to `ACTIVE`.
- Stage 1 to Stage 2, and Stage 2 to Funded Simulation (OQ-005). Funded Simulation itself is out of scope.
- A market on the account (OQ-020). `market_scope` was not added.
- `parent_account_id` and `first_trade_at`. Those fields would record decisions that are still open.
- Trader UI for purchasing or managing a challenge. The terminal and chart work belong to later modules.

## Files

Migration `apps/api/db/migrations/0003_challenge_accounts`. HTTP and rules under `apps/api/src/modules/accounts`. Shared contracts in `packages/shared/src/accounts.ts` and `packages/shared/src/decimal.ts`. SQL stays in the account module so `infrastructure/db` does not take on challenge rules.
