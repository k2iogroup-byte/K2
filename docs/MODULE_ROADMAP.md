# K2 Group — Module Roadmap

> **Phase:** Documentation-only foundation phase. Not production-ready.
> The **module list** is CONFIRMED from the brief §17. The **phasing, dependencies, and MVP classification** are PROPOSED, except where the brief explicitly places a module outside the MVP (Investor Copy Trading — CONFIRMED non-MVP) or leaves priority open (Global Competition — priority UNRESOLVED; PROPOSED non-MVP, consistent with MVP_SCOPE).

---

## 1. Module Catalogue

| ID | Module (from brief) | Classification | Basis |
|---|---|---|---|
| M-01 | Project Foundation | MVP | PROPOSED |
| M-02 | Authentication and User Management | MVP | PROPOSED |
| M-03 | Challenge and Account Management | MVP | PROPOSED |
| M-04 | Market Data Infrastructure | MVP | PROPOSED (real data CONFIRMED required) |
| M-05 | Trading Engine (simulation execution; broker adapter later) | MVP (simulation) / Phase 3 (broker) | PROPOSED |
| M-06 | Risk Management | MVP | PROPOSED |
| M-07 | Financial Ledger | MVP | PROPOSED (immutability CONFIRMED) |
| M-08 | Payments and Subscriptions | MVP | PROPOSED |
| M-09 | Payouts | MVP | PROPOSED |
| M-10 | KYC and Anti-Fraud | MVP (before first payout) | PROPOSED |
| M-11 | Trader Dashboard and Terminal | MVP | PROPOSED |
| M-12 | Admin Control System | MVP | PROPOSED |
| M-13 | Notifications | MVP (email + in-app) | PROPOSED |
| M-14 | Funded Simulation | MVP (blocked on OQ-030/OQ-031) | PROPOSED |
| M-15 | Real Account Management | Phase 3 (review workflow may start in MVP) | PROPOSED |
| M-16 | Profit Distribution and Scaling | Phase 3 | PROPOSED |
| M-17 | Investor Copy Trading | **Future — not MVP** | CONFIRMED non-MVP (BR-500) |
| M-18 | Global Competition | **Future — not MVP** | Priority UNRESOLVED; PROPOSED non-MVP |
| M-19 | Support and Compliance | MVP (core) | PROPOSED |
| M-20 | Infrastructure, Monitoring, Testing, and Launch | MVP | PROPOSED |

## 2. Module Detail

### M-01 Project Foundation
- **Scope:** repository structure, coding standards, CI/CD pipeline, environments, secrets management baseline, documentation (this set), decision process.
- **Depends on:** founder decisions on hosting (OQ-071) and frontend (OQ-070).
- **Exit criteria:** pipelines green, secret scanning active, environments provisioned, ADR process in place.
- **Module 01 implementation status:** the repository, local PostgreSQL migrations, CI workflow, and ADR record are implemented on `module-01-project-foundation`. The stack is an engineering selection (PROPOSED). OQ-070 and OQ-071 are not closed. Staging accounts are not provisioned; owner credentials are required. GitHub secret scanning and branch protection are owner settings, not objects this module can turn on. See [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md).

### M-02 Authentication and User Management
- **Scope:** registration, email verification, login, MFA, sessions, password reset, RBAC, staff SSO.
- **Depends on:** M-01.
- **Notes:** staff MFA mandatory (PROPOSED).

### M-03 Challenge and Account Management
- **Scope:** product catalogue (five CONFIRMED sizes/prices), rule-set versioning, account provisioning, lifecycle Stage 1 → Stage 2 → Funded Simulation, expiry, failure.
- **Depends on:** M-02, M-07, M-08.
- **Blocking questions:** OQ-001…OQ-005, OQ-020.

### M-04 Market Data Infrastructure
- **Scope:** vendor adapters, normalisation, timestamps, staleness detection, fan-out, snapshot persistence, bars for charts.
- **Depends on:** M-01; vendor licensing decisions (OQ-073, OQ-074).
- **Notes:** no fabricated prices; explicit stale/disconnected status (CONFIRMED).

### M-05 Trading Engine
- **Scope (MVP):** order management, simulation fill model (spread, liquidity, slippage, partial fills, sessions — CONFIRMED), positions.
- **Scope (Phase 3):** Broker Execution Adapter for equities Real Accounts, reconciliation.
- **Depends on:** M-04, M-06, M-07; broker selection (OQ-072) for Phase 3.

### M-06 Risk Management
- **Scope:** pre-trade checks, real-time equity and limit evaluation, breach detection, enforcement (forced close, lock), stage pass/fail, trading-day counting, warnings.
- **Depends on:** M-04, M-05, M-07.
- **Blocking questions:** OQ-001 (drawdown precision), OQ-002, OQ-030, OQ-040…OQ-045.
- **Notes:** highest-risk module; requires a signed-off written specification with worked examples before implementation.

### M-07 Financial Ledger
- **Scope:** double-entry, append-only journal; simulated vs real books; projections for balances; reconciliation tooling.
- **Depends on:** M-01.
- **Notes:** foundational — almost every module posts to it.

### M-08 Payments and Subscriptions
- **Scope:** Challenge checkout, provider webhooks, subscription cycles ($1 per $1,000 per 30 days from first trade — CONFIRMED), refunds, chargebacks.
- **Depends on:** M-02, M-07; payment provider (OQ-075).
- **Blocking questions:** OQ-010 (collection method), OQ-014 (refunds).

### M-09 Payouts
- **Scope:** eligibility engine (21 days/7 trading days first; 15 days/7 trading days subsequent; $50 minimum — CONFIRMED), request queue, trade-history review, execution, reconciliation.
- **Depends on:** M-06, M-07, M-10, M-12.
- **Blocking questions:** OQ-031 (Funded Simulation split), OQ-033, OQ-034 (payout rails).

### M-10 KYC and Anti-Fraud
- **Scope:** vendor KYC, sanctions/PEP screening, device fingerprinting, multi-account detection, behavioural abuse detection.
- **Depends on:** M-02; KYC vendor (OQ-076); legal jurisdiction review (OQ-080).

### M-11 Trader Dashboard and Terminal
- **Scope:** dark institutional PWA (CONFIRMED), charts from real data, order ticket, positions, rule meters, account history, payouts UI, session/feed status indicators.
- **Depends on:** M-02, M-03, M-04, M-05, M-06; frontend decision (OQ-070).

### M-12 Admin Control System
- **Scope:** role-scoped staff console, user/account views, audit search, payout review, ledger adjustments with dual control, rule-set drafting/approval, Real Account approval votes.
- **Depends on:** M-02, M-07.

### M-13 Notifications
- **Scope:** transactional email, in-app notifications; PWA push later.
- **Depends on:** M-02; events from M-03, M-06, M-08, M-09.

### M-14 Funded Simulation
- **Scope:** Funded Simulation account type, evaluation criteria (profitability, risk management, discipline, consistency, trading history — CONFIRMED), ~4–5 month horizon (not fixed — CONFIRMED), nomination for Real Account review.
- **Depends on:** M-03, M-06, M-09.
- **Blocking questions:** OQ-030 (rules), OQ-031 (payout split), OQ-032 (end state). **REQUIRES LEGAL REVIEW** for simulated-profit payouts.

### M-15 Real Account Management (Equities only)
- **Scope:** three-party approval workflow (CONFIRMED), broker account linkage, Real Account rules (CONFIRMED BR-401…BR-413), enforcement through broker, reconciliation, exit process.
- **Depends on:** M-05 (broker adapter), M-06, M-07, M-10, M-14; broker (OQ-072); legal structure (OQ-081).
- **Blocking questions:** OQ-040 (daily DD value), OQ-041, OQ-042, OQ-043, OQ-044.

### M-16 Profit Distribution and Scaling
- **Scope:** 70/10/20 allocation then 80/20 (CONFIRMED), trader reserve, company risk reserve, loss waterfall, scaling $100K → $200K at $24,000 reserve (CONFIRMED), exit reconciliation.
- **Depends on:** M-07, M-15.
- **Blocking questions:** OQ-050…OQ-055.

### M-17 Investor Copy Trading — FUTURE
- **Scope (future):** investor onboarding ($50,000 minimum), separate licensed custodian, copy mechanics, quarterly or semiannual settlement, High-Water Mark, 50/50 split, 50% loss coverage.
- **Status:** CONFIRMED not in MVP; REQUIRES LEGAL REVIEW (likely regulated investment management/collective investment activity in many jurisdictions).
- **Depends on:** mature M-15, M-16, M-10, custodian/broker agreements.

### M-18 Global Competition — FUTURE
- **Scope (future):** free 30-day stocks-only competition, $100,000 virtual capital, 1% daily / 3% total loss, one account per person, leaderboard, 79 Challenge-account prizes.
- **Status:** implementation priority UNRESOLVED (OQ-061); PROPOSED outside MVP. REQUIRES LEGAL REVIEW (prize promotion law). Contradiction: $300K prize vs removed $300K size (OQ-060).
- **Depends on:** M-02, M-04 (US equities data at scale — licensing cost per user is a key concern), M-06, M-10 (one-per-person verification).

### M-19 Support and Compliance
- **Scope:** ticketing, dispute workflow linked to audit evidence, terms and rulebook publication, complaints handling, regulatory record-keeping.
- **Depends on:** M-02, M-12.

### M-20 Infrastructure, Monitoring, Testing, and Launch
- **Scope:** hosting, observability, backups, DR drills, load and chaos testing (1K → 10K registered traders), penetration test, launch runbook, status page.
- **Depends on:** all MVP modules.

## 3. Proposed Reorganisation (PROPOSED)

The brief permits reorganisation where dependencies justify it. Recommendations:

1. **Promote M-07 Financial Ledger to the foundation tier** alongside M-01 and M-02, because Challenge purchases, commission, subscriptions, P&L, and payouts all depend on it.
2. **Split M-05 Trading Engine** into M-05a Simulation Execution (MVP) and M-05b Broker Execution Adapter (Phase 3), because they have different dependencies, risks, and vendors.
3. **Treat M-06 Risk Management as a specification-first module:** no build until OQ-001 and related questions are signed off.
4. **Merge M-15 and M-16 planning**, as distribution and scaling cannot be tested without Real Account flows.

## 4. Dependency Map (text form)

| Tier | Modules | Depend on |
|---|---|---|
| Tier 0 — Foundation | M-01, M-07, M-02 | — |
| Tier 1 — Core data | M-04, M-03, M-08, M-10 | Tier 0 |
| Tier 2 — Trading core | M-05a, M-06 | M-04, M-07, M-03 |
| Tier 3 — Experience & operations | M-11, M-12, M-13, M-19 | Tiers 0–2 |
| Tier 4 — Post-evaluation | M-14, M-09 | M-06, M-07, M-10, M-12 |
| Tier 5 — Launch readiness | M-20 | All MVP modules |
| Phase 3 — Real capital | M-05b, M-15, M-16 | Tier 4, broker, legal opinion |
| Future | M-17, M-18 | Phase 3 (M-17); Tiers 1–3 + legal (M-18) |

## 5. Proposed Phasing (PROPOSED — no dates committed)

| Phase | Goal | Modules | Gate to exit |
|---|---|---|---|
| Phase 0 | Decisions & specification | Documentation, decision workshop, legal opinion scoping | Blocking OQs closed; written risk-rule spec signed |
| Phase 1 | Foundation | M-01, M-02, M-07 | Security baseline, ledger invariants proven |
| Phase 2 | Challenge MVP | M-03, M-04, M-05a, M-06, M-08, M-10, M-11, M-12, M-13, M-19, M-20 | Launch gates in MVP_SCOPE met |
| Phase 2b | Funded Simulation & payouts | M-14, M-09 | Payout split confirmed; legal sign-off |
| Phase 3 | Real Accounts (equities) | M-05b, M-15, M-16 | Broker contract, regulatory clearance, pen test |
| Phase 4+ | Growth modules | M-18 (if prioritised), additional markets, PWA push | Founder prioritisation |
| Future | Investor Copy | M-17 | Full legal, regulatory, liquidity, operational review |

**Delivery realism note (PROPOSED):** institutional-quality risk, ledger, and data-licensing work is the critical path. Timelines should be set only after Phase 0 closes, not before.
