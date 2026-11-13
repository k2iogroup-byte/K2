# K2 Group — Technical Architecture (PROPOSED)

> **Status of this entire document: PROPOSED.** It is a recommendation from the planning team, not an approved design. Founder constraints from the brief are marked **CONFIRMED**; everything else is a recommendation pending decision. No code, configuration, or infrastructure has been created.

---

## 1. Confirmed Technology Constraints (from the brief)

| ID | Constraint | Status |
|---|---|---|
| TC-01 | Responsive web platform and installable PWA. | CONFIRMED |
| TC-02 | No native mobile app or Electron desktop app for MVP. | CONFIRMED |
| TC-03 | Professional dark institutional interface. | CONFIRMED |
| TC-04 | React-based frontend is a **candidate**, not a confirmed final choice. | UNRESOLVED (OQ-070) |
| TC-05 | Backend, database, hosting, and deployment architecture must be evaluated. | UNRESOLVED |
| TC-06 | Railway and Vercel are **candidate** hosting platforms. | UNRESOLVED (OQ-071) |
| TC-07 | GitHub is the source-control system. | CONFIRMED |
| TC-08 | Real market data is required for actual charts. | CONFIRMED |
| TC-09 | Market data feed and broker execution are **separate systems**. | CONFIRMED |
| TC-10 | Simulation must model realistic spread, liquidity, slippage, partial fills, and trading sessions. | CONFIRMED |
| TC-11 | Binance public WebSocket is a **possible** crypto data source. | CONFIRMED as candidate |
| TC-12 | US equities data provider to be selected after licensing and redistribution review. | REQUIRES LEGAL REVIEW (OQ-073) |
| TC-13 | No fake or fabricated live prices. | CONFIRMED |
| TC-14 | On feed disconnect, display explicit stale/disconnected status. | CONFIRMED |
| TC-15 | Scale: ~1,000 registered traders initially, growth toward ~10,000. | CONFIRMED |
| TC-16 | Never store API keys, passwords, or private credentials in GitHub source code. | CONFIRMED |

## 2. Architectural Principles (PROPOSED)

1. **Ledger first.** Money and account state are derived from an append-only, double-entry ledger. No mutable "balance" field is the source of truth.
2. **Deterministic risk.** Risk decisions are a pure function of (rule-set version, account state, market-data snapshot with timestamps). Every decision can be replayed.
3. **Separation of concerns.** Market data, simulated execution, broker execution, risk, and ledger are separate bounded contexts communicating through well-defined events.
4. **Modular monolith first, services where justified.** At 1K–10K registered traders, a well-structured modular backend plus a small number of dedicated long-running processes (market-data gateway, risk/execution engine) is lower risk than a microservice estate.
5. **Server is authoritative.** The browser never computes anything that affects money or rule compliance; it only displays.
6. **Fail safe on data loss.** Stale market data blocks new risk-taking and is surfaced; it never silently substitutes prices.
7. **Configuration over code for business rules.** Rule values (targets, limits, prices) live in versioned rule-sets, so a founder decision changes data, not code.

## 3. Logical Architecture

### 3.1 Component Overview

| Component | Responsibility | Runtime profile |
|---|---|---|
| Web Client (PWA) | Trader terminal, dashboard, account pages, admin console (separate build/origin recommended). | Static assets + client runtime |
| API Gateway / BFF | Authentication, session, rate limiting, request validation, routing to domain modules. | Stateless, horizontally scalable |
| Identity & Access | Users, credentials, MFA, sessions, roles, permissions. | Part of core backend |
| Catalogue & Accounts | Challenge products, rule-set versions, account lifecycle (Stage 1 → Stage 2 → Funded Simulation → Real). | Core backend |
| Market Data Gateway | Connects to external feeds (e.g., Binance public WebSocket for crypto; licensed US equities provider; FX provider TBD); normalises ticks/quotes; stamps source and receive timestamps; detects staleness; fans out to clients and engines. | **Long-running, stateful process** |
| Simulation Execution Engine | Matches simulated orders against real quotes using a versioned fill model (spread, depth/liquidity, slippage, partial fills, sessions). | **Long-running process** |
| Broker Execution Adapter | Routes Real Account (equities) orders to the selected broker; reconciles fills and positions. | Long-running; isolated network zone |
| Risk Engine | Real-time evaluation of daily loss, drawdown, position limits, holding time, trading-day counts, stage pass/fail; triggers enforcement. | **Long-running, low-latency** |
| Ledger Service | Double-entry, append-only journal for fees, commission, subscription, P&L, payouts, reserves, adjustments. | Core backend, strongly consistent |
| Billing & Payments | Challenge purchase, subscription cycles, provider webhooks, refunds/chargebacks. | Core backend + provider |
| Payout Service | Eligibility, request queue, review workflow, execution, reconciliation. | Core backend |
| KYC & Anti-Fraud | Vendor integration, device/IP signals, duplicate-identity detection, sanctions screening. | Core backend + vendor |
| Notification Service | Email, in-app, (later) push via PWA. | Async worker |
| Audit Log | Tamper-evident log of orders, executions, risk decisions, and admin actions. | Append-only store |
| Reporting / Analytics | Read replicas or warehouse for management reporting; never the source of truth. | Batch |

### 3.2 Data Flow — Simulated Trade (narrative)

1. Trader submits an order from the PWA through the API (idempotency key required).
2. API validates session and permission, then forwards to the Risk Engine for **pre-trade checks** (rule-set limits, market open, data freshness).
3. If accepted, the Simulation Execution Engine computes fills against the latest real quote snapshot using the fill model; partial fills are possible.
4. Each fill is written to the Order/Execution store and posted to the Ledger (position cost, commission 0.5% of opening BUY notional).
5. Risk Engine updates equity and limit consumption on every relevant price update and on every fill.
6. On breach, Risk Engine emits an enforcement command (e.g., close all positions, lock account) and a breach record.
7. Client receives order, position, and rule-meter updates via WebSocket.

### 3.3 Data Flow — Real Account Trade (narrative)

Identical pre-trade checks, but execution is routed through the Broker Execution Adapter. Broker fills are the authoritative execution record; the platform reconciles broker positions and cash daily (and intraday on events). Real Account enforcement (BR-411) issues close orders to the broker; the platform must handle broker rejects, partial fills, and halted securities explicitly (see OQ-044).

## 4. Market Data Architecture (PROPOSED)

| Topic | Recommendation |
|---|---|
| Source separation | Market data vendors are independent of the execution broker (CONFIRMED TC-09). The gateway abstracts each vendor behind a common normalised schema. |
| Crypto | Binance public WebSocket is a candidate (CONFIRMED as candidate). Check Binance terms of use for redistribution to end users and geographic restrictions — REQUIRES LEGAL REVIEW. Plan a secondary source for redundancy. |
| US equities | Provider selected only after licensing review covering display vs non-display use, per-user exchange fees, professional vs non-professional subscriber classification, and redistribution rights — REQUIRES LEGAL REVIEW. |
| Forex | Provider not specified — UNRESOLVED. FX has no central tape; quotes are provider-specific, which affects fairness of simulated fills. |
| Timestamps | Store **exchange/source timestamp**, **gateway receive timestamp**, and **publish timestamp** for every tick used in a risk or fill decision. |
| Staleness | Per-instrument heartbeat thresholds (e.g., crypto seconds, equities aligned to session). On threshold breach: mark instrument STALE, notify clients, block new opening orders. Policy for risk evaluation during staleness is UNRESOLVED (OQ-045). |
| Persistence | Retain tick/quote snapshots referenced by fills and breaches for the full audit retention period; retain aggregated bars for charts. |
| Fan-out | Clients subscribe per instrument; gateway coalesces updates (e.g., throttled to a maximum frequency per client) to protect browser and bandwidth. |

## 5. Simulation Fill Model (PROPOSED)

- Market orders fill at the opposite side of the current quote (ask for BUY), not at last trade or mid.
- Slippage applied as a function of order size relative to displayed depth/typical volume; parameters versioned.
- Partial fills when order size exceeds modelled available liquidity at a price level.
- Orders rejected outside trading sessions unless an explicit queuing policy is approved.
- Halts, auctions, and limit-up/limit-down events must be modelled for equities (policy UNRESOLVED).
- Each fill records the fill-model version and the quote snapshot used.

## 6. Hosting & Deployment Options (PROPOSED)

### 6.1 Railway vs Vercel (candidate evaluation)

| Criterion | Vercel | Railway |
|---|---|---|
| Static/PWA frontend hosting and global CDN | Strong fit | Possible, less specialised |
| Serverless request/response APIs | Strong fit | Supported via containers |
| Long-running WebSocket servers (market-data fan-out) | Not a natural fit for persistent server-side sockets in serverless functions; typically requires an external real-time service | Natural fit (persistent containers) |
| Long-running stateful engines (risk, execution) | Not a natural fit | Natural fit |
| Managed PostgreSQL / Redis | Via marketplace integrations | Built-in offerings |
| Regulatory/data-residency controls | Region selection available; verify against legal requirements | Region selection available; verify |
| Operational maturity for financial workloads | Verify SLAs, audit reports, and support tiers | Verify SLAs, audit reports, and support tiers |

**PROPOSED recommendation (not a decision):** A hybrid is likely most appropriate — the PWA on a CDN-oriented platform (Vercel is a strong candidate) and the long-running market-data, risk, and execution processes plus the primary database on a container platform (Railway is a candidate; a major cloud provider should also be evaluated for compliance and SLA reasons as scale grows). Final decision: **UNRESOLVED (OQ-071)**.

### 6.2 Environments (PROPOSED)

Development → Staging (production-like, synthetic users, real data feeds where licensing permits) → Production. Production financial data is never copied to lower environments unmasked.

### 6.3 Source Control & CI/CD (PROPOSED)

- GitHub (CONFIRMED) with protected main branch, mandatory reviews, signed commits for release branches, and automated secret scanning.
- CI runs static analysis, dependency vulnerability scanning, and the rule-acceptance test suite.
- Infrastructure defined declaratively and reviewed like application code.
- Secrets are injected from the hosting platform's secret store or a dedicated secrets manager — never committed (CONFIRMED TC-16).

## 7. Technology Stack Candidates (PROPOSED)

| Layer | Candidate(s) | Rationale | Status |
|---|---|---|---|
| Frontend | React (with a mature framework such as Next.js) | Ecosystem, charting libraries, PWA support, hiring. Alternatives: Vue, Svelte. | UNRESOLVED (OQ-070) |
| Charts | A professional financial charting library (licensing review required) | Institutional look, performance with live ticks | PROPOSED |
| Backend language | TypeScript (shared types with frontend) or a JVM/Go service for engines | Engines benefit from strong typing and predictable latency | PROPOSED |
| Primary database | PostgreSQL | ACID, exact numeric types, mature tooling, row-level security | PROPOSED |
| Cache / pub-sub | Redis (or equivalent) | Session cache, rate limits, ephemeral fan-out | PROPOSED |
| Event backbone | Start with a durable queue/outbox pattern on PostgreSQL; move to a streaming platform only if load requires | Avoid premature complexity | PROPOSED |
| Time-series | PostgreSQL extension or dedicated time-series store for ticks/bars | Audit snapshots and charts | PROPOSED |
| Observability | Metrics, structured logs, traces, uptime and synthetic checks | Incident management | PROPOSED |

## 8. Scale & Performance Strategy (PROPOSED)

### 8.1 Capacity Model

The brief instructs not to assume every registered trader is simultaneously active (CONFIRMED). Planning assumptions to validate:

| Parameter | ~1,000 registered | ~10,000 registered |
|---|---|---|
| Peak concurrent sessions (10–25%) | 100–250 | 1,000–2,500 |
| Instruments subscribed per session | 5–20 | 5–20 |
| Concurrent WebSocket connections | ≤ 500 (multi-tab) | ≤ 5,000 |
| Order submissions at peak | ~5–20 per second | ~50–200 per second |
| Open accounts under risk evaluation | ~1,000–3,000 | ~10,000–30,000 |

These figures are **planning hypotheses**, not commitments.

### 8.2 Hot-Path Design

- Risk evaluation is triggered per instrument tick for accounts holding that instrument (index accounts by instrument), not by scanning all accounts.
- Market-data fan-out is coalesced per client and per instrument.
- The ledger write path is strongly consistent; the read path (dashboards) uses projections.

### 8.3 Load-Testing Strategy

1. Build a replay harness that plays recorded real market sessions (including volatile opens and news spikes) at 1×, 5×, and 10× speed.
2. Simulate realistic session mixes: idle viewers, active traders, burst order entry near market open.
3. Measure: tick-to-client latency, tick-to-risk-decision latency, order-to-fill latency, ledger write throughput, WebSocket memory per connection, reconnect storms after a deploy or feed outage.
4. Chaos scenarios: feed disconnect, broker adapter outage, database failover, partial region outage.
5. Pass criteria agreed with the founder before launch (see MVP_SCOPE launch gates).

## 9. Reliability & Recovery (PROPOSED)

- Point-in-time recovery for the primary database; cross-region backup copies; quarterly restore drills.
- Risk engine restart must rebuild state from ledger + positions + latest snapshots before resuming enforcement; trading is paused for affected accounts until rebuilt.
- Broker reconciliation discrepancies raise incidents and freeze affected Real Accounts pending review.

## 10. Architecture Decisions Requiring Founder Input

See [DECISIONS_LOG.md](./DECISIONS_LOG.md) (pending proposals P-xxx) and [OPEN_QUESTIONS.md](./OPEN_QUESTIONS.md): OQ-070 (React), OQ-071 (Railway vs Vercel), OQ-072 (broker), OQ-073 (US equities data licensing), OQ-074 (FX data source), OQ-075 (payment processor), OQ-076 (KYC vendor).

## 11. Module 01 implementation note (2026-11-13)

This section records what Module 01 built. It does not change the confirmed constraints in §1. Choices the brief left open (TC-04, TC-05, TC-06) are implemented as **PROPOSED** engineering selections so the repository has one working stack. They are not founder approvals of OQ-070 or OQ-071. Reasons, alternatives, cost, and scaling notes are in [TECH_STACK_DECISIONS.md](./TECH_STACK_DECISIONS.md) and [ARCHITECTURE_DECISIONS.md](./ARCHITECTURE_DECISIONS.md).

| Layer | Implemented in Module 01 | Status |
|---|---|---|
| Frontend | Next.js, React, TypeScript. Dark shell and PWA manifest only. No terminal | PROPOSED (React candidate; OQ-070 open) |
| Backend | Node.js, TypeScript, Fastify, one modular monolith | PROPOSED runtime. A separate backend is required by the Module 01 specification. Polyglot engines are not introduced |
| Database | PostgreSQL 16, SQL migrations with rollback. No business tables | Required by the Module 01 specification |
| Redis | Not introduced | Deferred until a module needs shared ephemeral state |
| CI | GitHub Actions. No deploy job | Required by the Module 01 specification |
| Staging targets | Config for Vercel (frontend) and Railway (API + Postgres). No accounts created | PROPOSED (OQ-071 open) |
