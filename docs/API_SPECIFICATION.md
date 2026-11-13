# K2 Group — API Specification (PROPOSED)

> **Status of this entire document: PROPOSED**, except the implementation notes below. The tables in this file are still a recommended future surface. They are not the implemented contract.
>
> **Module 02 (implemented):** authentication and user management are implemented without a `/v1` prefix and without refresh tokens. The contract, including paths and schemas, is [MODULE_02_AUTHENTICATION.md](./MODULE_02_AUTHENTICATION.md). The `/v1/auth/*` rows below remain PROPOSED and were not built.
>
> **Module 03 (implemented):** challenge catalogue, immutable rule-set versions, and account lifecycle are implemented without a `/v1` prefix. Checkout, metrics, and ledger routes below were not built. The contract is [MODULE_03_CHALLENGE_ACCOUNTS.md](./MODULE_03_CHALLENGE_ACCOUNTS.md).

---

## 1. Conventions (PROPOSED)

| Topic | Recommendation |
|---|---|
| Style | Resource-oriented HTTPS JSON API for commands and queries; WebSocket for real-time streams. |
| Versioning | Path prefix `/v1`; breaking changes only in new major versions. |
| Authentication | Short-lived access token + rotating refresh token in secure, HttpOnly, SameSite cookies for the PWA. Staff console on a separate origin with mandatory MFA. |
| Authorisation | RBAC evaluated server-side on every request; resource ownership checks (a trader may only access own accounts). |
| Idempotency | All state-changing financial or trading requests require an `Idempotency-Key` header; replays return the original result. |
| Money format | Decimal values transmitted as strings with explicit currency (e.g., amount "699.00", currency "USD") to avoid floating-point loss. |
| Timestamps | ISO 8601 UTC with millisecond precision. Market data includes `source_ts` and `received_ts`. |
| Errors | Uniform error object: machine code, human message, correlation id, and — for rule rejections — the rule ID and rule-set version (e.g., BR-404). |
| Pagination | Cursor-based. |
| Rate limiting | Per user, per IP, and per endpoint class; stricter limits on authentication, order entry, and payout endpoints. Responses advertise remaining quota. |
| Correlation | Every request carries a request id propagated into audit logs. |

## 2. Public / Catalogue

| Method | Path | Purpose | Auth | Status |
|---|---|---|---|---|
| GET | /v1/catalogue/challenges | List active Challenge sizes and prices (CONFIRMED values from BR-100…104). | None | PROPOSED |
| GET | /v1/catalogue/rulesets/{version} | Published rule-set parameters for transparency. | None | PROPOSED |
| GET | /v1/markets | Markets and capability flags (Real Account: equities only). | None | PROPOSED |
| GET | /v1/status | Platform and data-feed status page. | None | PROPOSED |

## 3. Identity & Session

| Method | Path | Purpose | Notes |
|---|---|---|---|
| POST | /v1/auth/register | Create user | Email verification required; bot protection. |
| POST | /v1/auth/verify-email | Confirm email | Single-use token. |
| POST | /v1/auth/login | Password step | Generic error messages; throttled. |
| POST | /v1/auth/mfa/verify | MFA step | TOTP or WebAuthn. |
| POST | /v1/auth/refresh | Rotate tokens | Refresh-token reuse detection revokes session family. |
| POST | /v1/auth/logout | Revoke session | |
| GET | /v1/me/sessions | List sessions/devices | |
| DELETE | /v1/me/sessions/{id} | Revoke a session | |
| POST | /v1/me/mfa | Enrol factor | Re-authentication required. |
| POST | /v1/auth/password-reset | Request / complete reset | Notifies user; revokes sessions on completion. |

## 4. Purchases & Subscriptions

| Method | Path | Purpose | Notes |
|---|---|---|---|
| POST | /v1/checkout/challenge | Create checkout for a size | Price taken from server catalogue version, never from client. |
| POST | /v1/webhooks/payments/{provider} | Provider callback | Signature verification, replay protection, idempotent processing. Account provisioning occurs only here. |
| GET | /v1/me/payments | Payment history | |
| GET | /v1/accounts/{id}/subscription | Current cycle, next charge date, amount ($1 per $1,000, 30-day cycle) | Collection method UNRESOLVED (OQ-010). |

## 5. Trading Accounts

| Method | Path | Purpose |
|---|---|---|
| GET | /v1/accounts | List own accounts with type, stage, state |
| GET | /v1/accounts/{id} | Account details incl. rule-set version |
| GET | /v1/accounts/{id}/metrics | Balance, equity, daily loss used, drawdown used, trading days, days remaining, target progress |
| GET | /v1/accounts/{id}/history | State transitions and stage history |
| GET | /v1/accounts/{id}/ledger | Trader-visible ledger lines (fees, commission, P&L, payouts, reserves) |
| GET | /v1/accounts/{id}/breaches | Breach records with evidence (prices, timestamps, sources) |

## 6. Orders & Positions

| Method | Path | Purpose | Notes |
|---|---|---|---|
| POST | /v1/accounts/{id}/orders | Submit order | Fields: instrument, side (BUY to open — CONFIRMED for Real; SELL/short UNRESOLVED), quantity_type (SHARES or NOTIONAL_USD), quantity, order_type. Requires idempotency key. Pre-trade risk checks return rule ID on rejection. |
| GET | /v1/accounts/{id}/orders | List orders | |
| GET | /v1/accounts/{id}/orders/{orderId} | Order detail with fills | Fill includes quote snapshot reference and fill-model version. |
| DELETE | /v1/accounts/{id}/orders/{orderId} | Cancel working order | If non-market orders are approved. |
| GET | /v1/accounts/{id}/positions | Open positions | Includes opened_at and earliest permitted close time (2-minute rule for Real). |
| POST | /v1/accounts/{id}/positions/{positionId}/close | **Close Position** | CONFIRMED action name for Real Accounts (BR-412). Rejected before 2 minutes for trader-initiated closes (BR-405); forced closes governed by OQ-042. |

**Pre-trade checks (PROPOSED order of evaluation):** session open → instrument data not STALE → account ACTIVE → one position per asset (Real) → notional ≤10% capital (Real) → per-trade risk ≤2% (Real; method UNRESOLVED) → projected limit headroom → commission estimate.

## 7. Payouts

| Method | Path | Purpose | Notes |
|---|---|---|---|
| GET | /v1/accounts/{id}/payouts/eligibility | Shows calendar days, trading days, next eligible date, available amount | Rules BR-350/351/352 (CONFIRMED). |
| POST | /v1/accounts/{id}/payouts | Request payout | MFA step-up; minimum $50; enters review — no instant payout (CONFIRMED). |
| GET | /v1/accounts/{id}/payouts | Request history and status | Rejections include rule references. |

## 8. Real Accounts (Trader View)

| Method | Path | Purpose |
|---|---|---|
| GET | /v1/accounts/{id}/distribution | Profit allocations (70/10/20 or 80/20), trader reserve balance, threshold progress |
| GET | /v1/accounts/{id}/scaling | Scaling eligibility (only $100K→$200K at $24,000 reserve is CONFIRMED) |
| POST | /v1/accounts/{id}/exit | Initiate exit (BR-454); requires confirmation and step-up MFA |

## 9. Real-Time Streams (WebSocket)

| Channel | Content | Notes |
|---|---|---|
| market.{instrument} | Quotes/trades with source_ts, received_ts, status | Throttled per client; explicit STALE/DISCONNECTED events (CONFIRMED requirement). |
| feed.status | Global feed health | |
| account.{id}.metrics | Equity, limit usage, warnings | Server-computed only. |
| account.{id}.orders | Order and fill events | |
| account.{id}.notifications | Breach, stage, payout events | |

Connection rules (PROPOSED): authenticated on connect, re-validated on token rotation, per-user connection cap, server heartbeats, client resubscription with sequence numbers to detect gaps.

## 10. Staff / Admin API (separate origin)

| Method | Path | Purpose | Required role |
|---|---|---|---|
| GET | /v1/admin/users/{id} | User profile, KYC state, accounts | SUPPORT+ |
| GET | /v1/admin/accounts/{id}/audit | Full order/execution/risk audit trail | RISK |
| GET | /v1/admin/payouts/queue | Pending payout reviews | RISK, FINANCE |
| POST | /v1/admin/payouts/{id}/review | Record trade-history review and decision | RISK (four-eyes above threshold) |
| POST | /v1/admin/payouts/{id}/execute | Execute approved payout | FINANCE |
| POST | /v1/admin/real-reviews/{id}/votes | Record approval vote | RISK, TRADING_REVIEW, MANAGEMENT (one each) |
| POST | /v1/admin/ledger/adjustments | Propose manual adjustment | FINANCE (propose) + MANAGEMENT (approve) |
| POST | /v1/admin/rulesets | Draft new rule-set version | ADMIN (draft) + MANAGEMENT (approve) |
| POST | /v1/admin/accounts/{id}/suspend | Suspend account with reason | RISK, COMPLIANCE |
| GET | /v1/admin/audit-events | Search audit log | COMPLIANCE, MANAGEMENT |

All staff mutations: mandatory reason field, audit event, and — for financial effects — dual control.

## 11. Integration Interfaces (PROPOSED, provider-agnostic)

| Interface | Direction | Notes |
|---|---|---|
| Market data vendors | Inbound streams | Binance public WebSocket (candidate, crypto); US equities vendor after licensing review; FX vendor TBD. |
| Broker execution (Real, equities) | Outbound orders, inbound fills/positions | Broker UNRESOLVED (OQ-072). Daily and event-driven reconciliation. |
| Payment provider | Checkout + webhooks | Provider UNRESOLVED (OQ-075). |
| Payout rails | Outbound transfers | UNRESOLVED; REQUIRES LEGAL REVIEW. |
| KYC vendor | Verification sessions + webhooks | UNRESOLVED (OQ-076). |
| Email/notification provider | Outbound | PROPOSED. |

## 12. Explicit Exclusions

No Investor Copy or Global Competition endpoints in MVP (CONFIRMED non-MVP). They will be specified in a later phase after legal review.
