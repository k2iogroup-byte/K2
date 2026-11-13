# K2 Group — Product Requirements Document (PRD)

> **Phase:** Documentation-only foundation phase. Not production-ready.
> **Business rules** are referenced by ID from [BUSINESS_PLAN.md](./BUSINESS_PLAN.md) and retain their tags there. Requirements derived directly from a CONFIRMED rule are marked CONFIRMED; requirements authored by the planning team are PROPOSED.

---

## 1. Product Summary

K2 Group's platform lets retail traders purchase a trading Challenge, trade in a realistic simulated environment fed by real market data, progress through a two-stage evaluation, enter Funded Simulation, request payouts, and — after a separate management review — trade an equities Real Account funded with company capital.

The product must look and behave like an institutional tool: a **professional dark interface**, precise numbers, explicit data-feed status, and a transparent audit trail for every financial event.

## 2. User Roles

| Role | Description | Status |
|---|---|---|
| Visitor | Unauthenticated user browsing marketing pages and the Rulebook. | PROPOSED |
| Trader | Registered retail customer holding one or more trading accounts. | CONFIRMED (BR-005) |
| Support Agent | Reads trader profiles and tickets; cannot alter balances or rules. | PROPOSED |
| Risk Manager | Reviews breaches, payout requests, and Real Account candidacy. | CONFIRMED (Risk Management is a named approver, BR-303) |
| Trading Department Reviewer | Reviews trading behaviour for Real Account approval. | CONFIRMED (BR-303) |
| Company Management | Final approval for Real Accounts; approves high-value payouts. | CONFIRMED (BR-303) |
| Finance Operator | Executes approved payouts and reconciliations. | PROPOSED |
| Compliance Officer | KYC/AML decisions, sanctions screening, regulatory reporting. | PROPOSED |
| Platform Administrator | Configuration and user administration under strict RBAC; no unilateral financial edits. | PROPOSED |
| Investor (future) | Holds a Copy Account. Not MVP. | CONFIRMED as future (BR-500) |
| Competition Participant (future) | Free Global Competition entrant. Not MVP. | CONFIRMED as future (BR-550) |

## 3. Primary User Journeys

### 3.1 Challenge Purchase to Funded Simulation (MVP)

1. Visitor reads the Rulebook and pricing (BR-100…BR-104).
2. Visitor registers, verifies email, and enables MFA (PROPOSED).
3. Trader selects an account size and pays the Challenge price.
4. Platform provisions a Stage 1 simulated account with the purchased starting capital.
5. First executed trade starts the subscription cycle (BR-201) and — subject to OQ-004 — possibly the duration clock.
6. Trader trades; the risk engine monitors daily loss (5%), total drawdown (8%), trading days (≥7), and duration (≤30 days) in real time.
7. On meeting the 8% profit target with ≥7 trading days and no breach, Stage 1 is passed.
8. Stage 2 account is provisioned (mechanics UNRESOLVED, OQ-005); target 5%, ≤60 days.
9. On passing Stage 2, trader enters **Funded Simulation** (BR-125). Not a Real Account.

### 3.2 Funded Simulation and Payouts (MVP)

1. Trader trades the Funded Simulation account under rules still to be confirmed (OQ-030).
2. After 21 calendar days and ≥7 trading days, the trader may request a first payout ≥$50 (BR-350, BR-352).
3. Request triggers a complete trade-history review (BR-354) by Risk.
4. Approved payout is executed by Finance and recorded as immutable ledger events.
5. Subsequent requests every 15 calendar days with ≥7 trading days (BR-351).

### 3.3 Real Account Candidacy (MVP: review workflow only; live trading PROPOSED for a later phase)

1. After approximately 4–5 months (BR-300), Risk nominates a Funded Simulation trader (equities only, BR-400).
2. Risk Management, Trading Department, and Company Management each record an approval or rejection (BR-303).
3. On unanimous approval, a Real Account is provisioned with the broker (UNRESOLVED broker, OQ-072).
4. Real Account rules (BR-401…BR-413) are enforced automatically.
5. Profits are distributed 70/10/20 until the reserve threshold, then 80/20 (BR-450, BR-451).

### 3.4 Trader Exit from Real Account

Per BR-454: close open positions → reconcile → deduct liabilities from trader reserve → return remaining reserve per policy (policy UNRESOLVED, OQ-052). Trader never owes additional money (BR-455).

## 4. Functional Requirements

### 4.1 Account & Identity

| ID | Requirement | Status |
|---|---|---|
| FR-001 | Users can register with email and password and must verify their email. | PROPOSED |
| FR-002 | Multi-factor authentication is available to all users and **mandatory** for staff roles and for payout requests. | PROPOSED |
| FR-003 | Users can view and terminate active sessions and devices. | PROPOSED |
| FR-004 | KYC verification is required before first payout and before Real Account provisioning. | PROPOSED; REQUIRES LEGAL REVIEW |
| FR-005 | One verified identity may hold multiple Challenges; limits on concurrent accounts are configurable. | PROPOSED (limit UNRESOLVED) |

### 4.2 Challenge Catalogue & Purchase

| ID | Requirement | Status |
|---|---|---|
| FR-010 | Display exactly the confirmed sizes and prices: $10K/$129, $25K/$250, $50K/$399, $100K/$699, $200K/$1,200. | CONFIRMED |
| FR-011 | Do not offer $5,000 or $300,000 sizes. | CONFIRMED |
| FR-012 | Sizes above $200,000 up to $1,000,000 are hidden until confirmed. | CONFIRMED (cap) / PROPOSED (hidden) |
| FR-013 | Prices are stored as versioned catalogue entries; a purchase records the exact catalogue version and rule-set version. | PROPOSED |
| FR-014 | Payment confirmation must be server-verified (provider webhook) before account provisioning. | PROPOSED |

### 4.3 Trading Terminal

| ID | Requirement | Status |
|---|---|---|
| FR-020 | Real-time charts from real market data only; no fabricated prices. | CONFIRMED |
| FR-021 | Explicit **stale / disconnected** indicator when the feed drops; trading actions on stale instruments are blocked or warned (policy PROPOSED: block). | CONFIRMED (indicator) / PROPOSED (block) |
| FR-022 | Order entry with **BUY** to open and **Close Position** to close. | CONFIRMED for Real Accounts (BR-412); applicability to Challenge/crypto/forex UNRESOLVED (OQ-013) |
| FR-023 | Size entry in **shares or USD notional** for equities. | CONFIRMED (Real Accounts, BR-413); PROPOSED for Challenge equities |
| FR-024 | Pre-trade display of estimated commission (0.5% of opening notional) and estimated fill. | CONFIRMED (rate) / PROPOSED (display) |
| FR-025 | Positions, orders, fills, P&L (realised/unrealised), balance, equity, and live rule meters (daily loss used, drawdown used, trading days, days remaining, target progress). | PROPOSED |
| FR-026 | Market session indicator (pre-market, regular, after-hours, closed; crypto 24/7; FX weekly session). | PROPOSED |
| FR-027 | Every displayed price carries a source timestamp; the UI shows data latency. | CONFIRMED (timestamps) / PROPOSED (latency display) |

### 4.4 Simulation Execution

| ID | Requirement | Status |
|---|---|---|
| FR-030 | Simulated fills must model realistic **spread, liquidity, slippage, partial fills, and trading sessions**. | CONFIRMED |
| FR-031 | Orders on closed markets are rejected or queued per a documented policy. | PROPOSED (policy UNRESOLVED) |
| FR-032 | Simulation model parameters are versioned and recorded on each fill for audit and dispute resolution. | PROPOSED |
| FR-033 | Swap/overnight financing is zero. | CONFIRMED (BR-210) |

### 4.5 Risk Enforcement

| ID | Requirement | Status |
|---|---|---|
| FR-040 | Enforce Challenge Stage 1/2 limits exactly as specified in BR-120…BR-124 once formulas are confirmed (OQ-001). | CONFIRMED (values) / UNRESOLVED (formulas) |
| FR-041 | Enforce Real Account limits BR-401…BR-411, including automatic breach closure. | CONFIRMED |
| FR-042 | Pre-trade checks: position notional ≤10% of capital; one open position per asset; per-trade risk ≤2% (method UNRESOLVED, OQ-041). | CONFIRMED (limits) |
| FR-043 | Block trader-initiated close before 2 minutes holding time (interaction with forced closure UNRESOLVED, OQ-042). | CONFIRMED (rule) |
| FR-044 | Every breach produces an immutable breach record with the triggering price, timestamp, data source, and equity snapshot. | PROPOSED |
| FR-045 | Traders receive immediate in-app and email notice of warnings (e.g., 80% of a limit used, PROPOSED threshold) and breaches. | PROPOSED |

### 4.6 Subscription & Commission

| ID | Requirement | Status |
|---|---|---|
| FR-050 | Subscription of $1 per $1,000 account size per 30-day cycle starting at first executed trade, on Challenge, Funded Simulation, and Real Accounts. | CONFIRMED |
| FR-051 | Subscription collection method and failure handling. | UNRESOLVED (OQ-010) |
| FR-052 | Commission 0.5% on opening BUY; none on close. | CONFIRMED (cross-market UNRESOLVED) |

### 4.7 Payouts

| ID | Requirement | Status |
|---|---|---|
| FR-060 | Eligibility engine: first payout at 21 calendar days + ≥7 trading days; subsequent every 15 calendar days + ≥7 trading days; minimum $50. | CONFIRMED |
| FR-061 | No instant payout; every request enters a review queue with full trade-history review. | CONFIRMED |
| FR-062 | Rejection or reduction requires a documented, rule-referenced reason visible to the trader. | PROPOSED (supports BR-355) |
| FR-063 | Four-eyes approval for payouts above a configurable threshold. | PROPOSED |

### 4.8 Real Account & Profit Distribution

| ID | Requirement | Status |
|---|---|---|
| FR-070 | Three-party approval workflow (Risk, Trading, Management) with recorded decisions. | CONFIRMED |
| FR-071 | Ledger-driven 70/10/20 distribution, switching to 80/20 at the reserve threshold. | CONFIRMED |
| FR-072 | Trader reserve balance and company risk reserve visible to the trader (own share) and admins. | PROPOSED |
| FR-073 | Scaling eligibility flag at $24,000 reserve for $100K → $200K. | CONFIRMED (value) / UNRESOLVED (automatic vs review) |

### 4.9 Administration

| ID | Requirement | Status |
|---|---|---|
| FR-080 | Admin console with role-scoped views; no direct editing of balances — adjustments only through reasoned, dual-approved ledger entries. | PROPOSED |
| FR-081 | Rule-set management with versioning; a rule-set change never alters already-purchased accounts retroactively unless explicitly approved and disclosed. | PROPOSED; REQUIRES LEGAL REVIEW |
| FR-082 | Full audit log search for orders, fills, breaches, payouts, and admin actions. | CONFIRMED (audit logs) / PROPOSED (search UI) |

### 4.10 Notifications & Support

| ID | Requirement | Status |
|---|---|---|
| FR-090 | Transactional email + in-app notifications for purchase, stage changes, breaches, subscription charges, and payouts. | PROPOSED |
| FR-091 | Ticketing for support and disputes linked to account and trade records. | PROPOSED |

## 5. Non-Functional Requirements

| ID | Requirement | Status |
|---|---|---|
| NFR-001 | Responsive web platform, installable as a **PWA**. | CONFIRMED |
| NFR-002 | No native mobile app and no Electron desktop app for MVP. | CONFIRMED |
| NFR-003 | Professional dark institutional UI; light theme optional later. | CONFIRMED (dark) / PROPOSED (light later) |
| NFR-004 | Initial scale ~1,000 registered traders; architecture allows growth to ~10,000. Do not assume all registered traders are concurrently active. | CONFIRMED |
| NFR-005 | Planning targets: 10–25% peak concurrency of registered users (≈100–250 at launch; ≈1,000–2,500 at 10K). | PROPOSED (to be validated by load testing) |
| NFR-006 | Risk evaluation latency from price tick to breach decision: p99 ≤ 500 ms for simulated accounts. | PROPOSED |
| NFR-007 | All monetary values use exact decimal arithmetic; no binary floating point for money. | PROPOSED |
| NFR-008 | Every financial event is immutable and reconstructable; balances are derived from ledger events. | CONFIRMED (immutable ledger) |
| NFR-009 | Availability target 99.9% for trading and risk services during market hours. | PROPOSED |
| NFR-010 | RPO ≤ 5 minutes, RTO ≤ 1 hour for ledger and trading data. | PROPOSED |
| NFR-011 | Accessibility: WCAG 2.2 AA contrast within the dark theme. | PROPOSED |
| NFR-012 | Internationalisation-ready; English at launch. | PROPOSED |
| NFR-013 | All timestamps stored in UTC with millisecond (or better) precision; displayed in user locale. | PROPOSED |

## 6. Out of Scope for MVP

Investor Copy Trading (BR-500) and Global Competition (BR-550) — see [MVP_SCOPE.md](./MVP_SCOPE.md).

## 7. Acceptance Principles

- **PROPOSED:** Every rule in BUSINESS_PLAN must have an executable acceptance scenario (written in prose/tables during specification) with worked numeric examples signed off by the founder before engine implementation.
- **PROPOSED:** No requirement tagged UNRESOLVED may be implemented with a placeholder value in production.
