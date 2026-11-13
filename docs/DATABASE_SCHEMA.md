# K2 Group — Logical Database Schema (PROPOSED)

> **Status of this entire document: PROPOSED.** This is a logical data model described in tables and prose. Names, types, and relationships are recommendations for review. Business values referenced here (prices, limits, splits) are governed by [BUSINESS_PLAN.md](./BUSINESS_PLAN.md) and are stored as data, not hard-coded.
>
> **Module 01** added `schema_migrations` and `foundation_schema_info`.
>
> **Module 02 (implemented):** migration `0002_identity_access` creates `users`, `credentials`, `roles`, `permissions`, `role_permissions`, `user_roles`, `sessions`, `email_verification_tokens`, `password_reset_tokens`, `mfa_factors`, `mfa_recovery_codes`, `staff_invitations`, and append-only `authentication_audit_events`. Account status is `ACTIVE`, `SUSPENDED`, or `CLOSED`. Email verification is `email_verified_at`, not a status. The proposed `PENDING` status and `country_of_residence` were not created. Tokens and recovery codes are hashes. TOTP secrets are ciphertext. See [MODULE_02_AUTHENTICATION.md](./MODULE_02_AUTHENTICATION.md). The rest of this document remains a proposed logical model.
>
> **Module 03 (implemented):** migration `0003_challenge_accounts` creates `challenge_products`, `product_price_versions`, `product_activation_events`, `rule_sets`, `rule_set_versions`, `rule_parameters`, `purchase_evidence_references`, `trading_accounts`, `account_state_transitions`, `challenge_audit_events`, and `catalogue_commands`. It does not create a ledger, a subscription, or market-data tables. `market_scope`, `parent_account_id`, and `first_trade_at` were not added. See [MODULE_03_CHALLENGE_ACCOUNTS.md](./MODULE_03_CHALLENGE_ACCOUNTS.md).

---

## 1. Modelling Principles (PROPOSED)

1. **Primary store:** a relational ACID database (PostgreSQL recommended, see TECHNICAL_ARCHITECTURE §7).
2. **Money:** exact decimal type with fixed scale (recommendation: 4 decimal places for USD amounts, higher for prices and quantities — e.g., 8 for crypto quantities). Currency is always stored alongside amount. No floating point.
3. **Time:** all timestamps in UTC with microsecond precision. Market events carry source, receive, and processing timestamps.
4. **Identifiers:** opaque, non-sequential identifiers (e.g., UUIDv7 or ULID) exposed externally; no guessable IDs.
5. **Immutability:** ledger entries, executions, risk decisions, breach records, and audit events are **append-only**. Corrections are new compensating entries, never updates or deletes.
6. **Versioning:** products, prices, and rule-sets are versioned; accounts reference the exact version in force at purchase.
7. **Soft lifecycle:** accounts and users transition through explicit states; history of transitions is retained.
8. **Multi-market:** an `instrument` belongs to a `market` (EQUITIES, CRYPTO, FOREX, future). Market capability flags determine which account types are allowed (Real Accounts: EQUITIES only — CONFIRMED BR-400).

## 2. Domain Overview

| Domain | Entities |
|---|---|
| Identity & Access | user, credential, mfa_factor, session, role, permission, user_role |
| Compliance | kyc_case, kyc_document_ref, sanctions_check, fraud_signal, device_fingerprint |
| Catalogue | market, instrument, trading_session_calendar, challenge_product, product_price_version, rule_set, rule_set_version |
| Accounts | trading_account, account_stage_history, account_state_transition |
| Trading | order, execution (fill), position, position_event, fill_model_version |
| Market Data | quote_snapshot, bar, feed_status_event |
| Risk | risk_metric_snapshot, risk_decision, breach_record, enforcement_action, trading_day_record |
| Ledger | ledger_account, journal_entry, journal_line |
| Billing | payment, payment_provider_event, subscription, subscription_cycle, refund, chargeback |
| Payouts | payout_request, payout_review, payout_execution |
| Real Accounts | real_account_review, approval_vote, broker_account_link, broker_reconciliation |
| Distribution | profit_period, profit_allocation, trader_reserve, company_risk_reserve, scaling_event |
| Operations | admin_action, audit_event, notification, support_ticket |
| Future (not MVP) | copy_account, investor, copy_settlement, competition, competition_entry, leaderboard_snapshot |

## 3. Entity Definitions

### 3.1 Identity & Access

**user**

| Attribute | Type (logical) | Notes |
|---|---|---|
| id | identifier | Opaque |
| email | text, unique (case-insensitive) | Verified flag separate |
| email_verified_at | timestamp, nullable | |
| status | enum: PENDING, ACTIVE, SUSPENDED, CLOSED | |
| country_of_residence | ISO country code | Needed for eligibility — REQUIRES LEGAL REVIEW |
| created_at / updated_at | timestamp | |

**credential** — password hash (memory-hard algorithm), algorithm parameters, rotated_at. Never stores plaintext. Separate table so access can be restricted.

**mfa_factor** — type (TOTP, WebAuthn/passkey), encrypted secret or public key, last_used_at.

**session** — user_id, device reference, IP, user agent, created_at, last_seen_at, revoked_at, refresh token hash (never the token itself).

**role / permission / user_role** — RBAC with least privilege. Staff roles: SUPPORT, RISK, TRADING_REVIEW, MANAGEMENT, FINANCE, COMPLIANCE, ADMIN. Assignment records granted_by and granted_at.

### 3.2 Catalogue & Rules

**market** — code (EQUITIES, CRYPTO, FOREX), allows_challenge, allows_funded_simulation, allows_real_account (true only for EQUITIES — CONFIRMED).

**instrument** — market_id, symbol, venue, currency, tick size, lot/quantity precision, fractional allowed (UNRESOLVED for equities), status.

**trading_session_calendar** — per venue: regular/extended sessions, holidays, early closes, time zone.

**challenge_product** — account_size (decimal), market scope (UNRESOLVED whether per-market products), active flag.

**product_price_version** — product_id, price, currency, valid_from, valid_to, approved_by. Seed values to be loaded as data: 10,000→129; 25,000→250; 50,000→399; 100,000→699; 200,000→1,200 (CONFIRMED). No rows for 5,000 or 300,000 (CONFIRMED removed).

**rule_set_version** — immutable bundle of parameters per account type and stage. Illustrative parameter keys:

| Parameter | Stage 1 | Stage 2 | Funded Sim | Real (Equities) |
|---|---|---|---|---|
| profit_target_pct | 8 (CONFIRMED) | 5 (CONFIRMED) | n/a | n/a |
| daily_loss_limit_pct | 5 (CONFIRMED) | 5 (CONFIRMED) | UNRESOLVED | UNRESOLVED |
| max_total_drawdown_pct | 8 (CONFIRMED) | 8 (CONFIRMED) | UNRESOLVED | 10 (CONFIRMED) |
| drawdown_basis | UNRESOLVED | UNRESOLVED | UNRESOLVED | EQUITY, STATIC from initial (CONFIRMED) |
| daily_reset_time | UNRESOLVED | UNRESOLVED | UNRESOLVED | 00:00 UTC (CONFIRMED) |
| min_trading_days | 7 (CONFIRMED) | 7 (CONFIRMED) | — | — |
| max_duration_days | 30 (CONFIRMED) | 60 (CONFIRMED) | ~4–5 months, not fixed (CONFIRMED) | — |
| max_risk_per_trade_pct | — | — | UNRESOLVED | 2 (CONFIRMED; method UNRESOLVED) |
| max_position_notional_pct | — | — | UNRESOLVED | 10 (CONFIRMED) |
| max_open_positions_per_asset | — | — | UNRESOLVED | 1 (CONFIRMED) |
| min_holding_seconds | — | — | UNRESOLVED | 120 (CONFIRMED) |
| opening_commission_pct | 0.5 (CONFIRMED, cross-market UNRESOLVED) | 0.5 | 0.5 | 0.5 |
| closing_commission_pct | 0 (CONFIRMED) | 0 | 0 | 0 |
| swap_rate | 0 (CONFIRMED) | 0 | 0 | 0 |
| subscription_per_1000_per_cycle | 1 USD (CONFIRMED) | 1 USD | 1 USD | 1 USD |
| subscription_cycle_days | 30 (CONFIRMED) | 30 | 30 | 30 |

Each rule_set_version records approved_by, approved_at, and a link to the decision record (D-xxx).

### 3.3 Accounts

**trading_account**

| Attribute | Notes |
|---|---|
| id, user_id | |
| account_type | CHALLENGE, FUNDED_SIMULATION, REAL (EQUITIES only) |
| stage | STAGE_1, STAGE_2, null |
| market_scope | per OQ-020 |
| initial_capital | decimal |
| rule_set_version_id | immutable reference |
| product_price_version_id | for Challenge purchases |
| state | PROVISIONED, ACTIVE, PASSED, FAILED, EXPIRED, SUSPENDED, UNDER_REVIEW, CLOSED |
| first_trade_at | starts subscription (CONFIRMED BR-201) |
| parent_account_id | links Stage 2 → Stage 1, Funded → Stage 2, Real → Funded |
| opened_at / closed_at | |

**account_state_transition** — from_state, to_state, reason_code, actor (system or staff), risk_decision_id or admin_action_id, timestamp. Append-only.

### 3.4 Trading

**order** — account_id, instrument_id, side (BUY; SELL/short UNRESOLVED), intent (OPEN, CLOSE_POSITION, FORCED_CLOSE), quantity_type (SHARES or NOTIONAL_USD — CONFIRMED for Real), requested_quantity, order_type (MARKET; LIMIT/STOP UNRESOLVED), idempotency_key (unique per account), client_submitted_at, server_received_at, status, rejection_reason.

**execution** — order_id, fill_price, fill_quantity, liquidity/slippage components, quote_snapshot_id, fill_model_version_id (simulation) or broker_execution_ref (real), executed_at. Append-only.

**position** — account_id, instrument_id, quantity, average cost, opened_at (for 2-minute rule), status. Constraint: at most one OPEN position per (account, instrument) — CONFIRMED for Real Accounts (BR-403); UNRESOLVED for other account types.

**position_event** — OPENED, INCREASED (if permitted, UNRESOLVED), PARTIALLY_CLOSED (UNRESOLVED), CLOSED, FORCE_CLOSED.

### 3.5 Market Data

**quote_snapshot** — instrument_id, bid, ask, bid_size, ask_size, last, source, source_ts, received_ts, processed_ts, sequence number. Retained when referenced by an execution or risk decision.

**feed_status_event** — source, instrument scope, status (LIVE, DEGRADED, STALE, DISCONNECTED), detected_at, resolved_at.

### 3.6 Risk

**trading_day_record** — account_id, date (definition UNRESOLVED, OQ-002), qualifying flag, trade count.

**risk_metric_snapshot** — account_id, timestamp, balance, equity, day_start_reference, peak_reference, daily_loss_used, total_drawdown_used, rule_set_version_id. Periodic + on event.

**risk_decision** — account_id, decision type (PRE_TRADE_ACCEPT, PRE_TRADE_REJECT, WARNING, BREACH, STAGE_PASS, STAGE_FAIL, EXPIRY), inputs hash, quote_snapshot ids, rule parameter values used, outcome, timestamp. Append-only; replayable.

**breach_record** — rule breached, threshold, observed value, equity snapshot, triggering quote, enforcement_action_id.

**enforcement_action** — CLOSE_ALL, LOCK_TRADING, SUSPEND; resulting order ids; completed_at.

### 3.7 Ledger (Double-Entry)

**ledger_account** — owner type (TRADER_ACCOUNT, TRADER_RESERVE, COMPANY_RISK_RESERVE, COMPANY_REVENUE, PAYOUT_PAYABLE, PAYMENT_CLEARING, etc.), owner id, currency, nature (simulated vs real money — **must be explicitly distinguished**).

**journal_entry** — id, entry type (CHALLENGE_FEE, SUBSCRIPTION_CHARGE, COMMISSION, REALISED_PNL, PAYOUT, RESERVE_ALLOCATION, LOSS_ABSORPTION, ADJUSTMENT, REVERSAL), reference to source event, created_at, created_by, approval reference for manual entries, hash of previous entry (tamper-evident chain).

**journal_line** — entry_id, ledger_account_id, debit/credit, amount, currency. Invariant: debits = credits per entry.

**Key invariant (PROPOSED):** simulated account P&L and real money movements are recorded in separate ledger books. A Funded Simulation payout is a real-money entry referencing, but not mutating, the simulated book.

### 3.8 Billing

**payment** — provider, provider reference, amount, currency, status, purpose (CHALLENGE_PURCHASE, SUBSCRIPTION), verified_via_webhook_at.

**payment_provider_event** — raw signed payload reference, signature verified flag, idempotent processing marker.

**subscription / subscription_cycle** — account_id, rate per 1,000, account size at cycle start, cycle_start (first cycle = first_trade_at), cycle_end (+30 days), amount, collection status. Collection method UNRESOLVED (OQ-010).

**refund / chargeback** — linked to payment; chargeback triggers fraud review.

### 3.9 Payouts

**payout_request** — account_id, requested_amount (≥ 50 USD, CONFIRMED), eligibility evaluation snapshot (calendar days since start/last payout, trading days count), status (SUBMITTED, UNDER_REVIEW, APPROVED, PARTIALLY_APPROVED, REJECTED, PAID, FAILED).

**payout_review** — reviewer, checklist results, trade-history review completed flag (CONFIRMED requirement), rule references for any deduction (supports BR-355), decision.

**payout_execution** — method, destination reference (tokenised), provider reference, executed_at, ledger entry id.

### 3.10 Real Accounts, Distribution, Scaling

**real_account_review** — candidate account, opened_at, status. **approval_vote** — department (RISK, TRADING, MANAGEMENT — CONFIRMED), voter, decision, rationale, timestamp. Real Account creation requires all three approvals.

**profit_allocation** — profit_period_id, gross profit, trader_payout_amount, trader_reserve_amount, company_share_amount, split_regime (70/10/20 or 80/20 — CONFIRMED), threshold in force.

**trader_reserve / company_risk_reserve** — modelled as ledger accounts; balances derived from journal lines.

**scaling_event** — from_capital, to_capital, reserve balance at decision, approved_by. Only $100,000 → $200,000 at $24,000 reserve is CONFIRMED; other thresholds stored only after founder decision.

### 3.11 Operations

**audit_event** — actor, action, target, before/after references, IP, request id, timestamp, hash chain. Append-only; write-once storage tier recommended.

**admin_action** — privileged changes with reason, approver (four-eyes), linked audit_event.

### 3.12 Future (Not MVP)

Placeholders only, to avoid blocking design later: investor, copy_account (linked to master real account; separate custodian reference), copy_settlement (period, high-water mark, 50/50 split, loss-coverage amount), competition, competition_entry (one per verified person), leaderboard_snapshot. **Not to be built in MVP.**

## 4. Retention & Archival (PROPOSED; REQUIRES LEGAL REVIEW)

Financial ledger, orders, executions, risk decisions, payouts, KYC: retain for the statutory period of the operating jurisdiction (commonly 5–7 years; to be confirmed by counsel). Raw tick data not referenced by decisions may be aggregated after a shorter period.

## 5. Open Schema Questions

Account-per-market vs multi-market accounts (OQ-020); short selling representation (OQ-013); Challenge drawdown references (OQ-001); Funded Simulation parameters (OQ-030); reserve pooling (OQ-053).
