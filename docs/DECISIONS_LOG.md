# K2 Group — Decisions Log

> **Phase:** Documentation-only foundation phase. Not production-ready.
> This log has two strictly separated parts:
> - **Part A — Confirmed Founder Decisions (D-xxx):** taken verbatim or near-verbatim from the founder brief `K2-MASTER-PLAN.txt`. Tag: CONFIRMED.
> - **Part B — Pending Recommendations (P-xxx):** proposals from the planning team. Tag: PROPOSED. **None of these are approved.**
>
> A recommendation moves to Part A only when the founder explicitly approves it; the entry then records the date and approver.

Source date for all Part A entries: founder brief as received for the documentation phase (2026-11-13).

---

## Part A — Confirmed Founder Decisions

### A.1 Phase Governance

| ID | Decision | Brief § | Status |
|---|---|---|---|
| D-001 | Current phase is research, analysis, documentation, architecture planning, and identification of missing decisions only. No application code. | 1 | CONFIRMED |
| D-002 | Do not modify or delete existing repository files; do not invent business rules. | 1 | CONFIRMED |
| D-003 | Do not mark the project production-ready. | 19 | CONFIRMED |

### A.2 Company & Markets

| ID | Decision | Brief § | Status |
|---|---|---|---|
| D-010 | Company name K2 Group; international proprietary trading firm; long-term broader financial group. | 2 | CONFIRMED |
| D-011 | Initial customer segment: retail traders purchasing Challenges. | 2 | CONFIRMED |
| D-012 | Equities: Challenge, Funded Simulation, Real Accounts. Crypto and Forex: Challenge and Funded Simulation only. | 3 | CONFIRMED |
| D-013 | Real Accounts exclusively for equities; other markets may receive company-funded payouts for verified Funded Simulation profits. | 3 | CONFIRMED |
| D-014 | Design for multi-market expansion without building every market at launch. | 3 | CONFIRMED |

### A.3 Challenge

| ID | Decision | Brief § | Status |
|---|---|---|---|
| D-020 | Prices: $10K → $129; $25K → $250; $50K → $399; $100K → $699; $200K → $1,200. | 4 | CONFIRMED |
| D-021 | Maximum Challenge size $1,000,000; larger sizes/prices need confirmation. | 4 | CONFIRMED |
| D-022 | $5,000 and $300,000 sizes removed. | 4 | CONFIRMED |
| D-023 | Two-stage evaluation: Stage 1 target 8%, Stage 2 target 5%; daily loss 5% both; max total drawdown 8% both; min 7 trading days both; max duration 30 / 60 days. | 5 | CONFIRMED |
| D-024 | Passing both stages leads to Funded Simulation, not automatic Real Account access. | 5 | CONFIRMED |
| D-025 | Drawdown calculations and enforcement must be precisely documented before implementation. | 5 | CONFIRMED |

### A.4 Fees

| ID | Decision | Brief § | Status |
|---|---|---|---|
| D-030 | Subscription $1 per $1,000 account size per month; starts with first executed trade; repeats every 30 days; applies to Challenge, Funded Simulation, Real Accounts. | 6 | CONFIRMED |
| D-031 | Commission 0.5% on opening BUY; no closing commission (current decision). | 6 | CONFIRMED |
| D-032 | Cross-market commission must be confirmed before implementation. | 6 | CONFIRMED (as a pending requirement) |
| D-033 | Swap = 0. Do not assume broker fees or market-specific charges. | 6 | CONFIRMED |

### A.5 Funded Simulation & Payouts

| ID | Decision | Brief § | Status |
|---|---|---|---|
| D-040 | Funded Simulation approx. 4–5 months, not guaranteed fixed. | 7 | CONFIRMED |
| D-041 | Evaluation on profitability, risk management, discipline, consistency, trading history. | 7 | CONFIRMED |
| D-042 | Company may pay verified simulation profits from own funds. | 7 | CONFIRMED (REQUIRES LEGAL REVIEW for operation) |
| D-043 | Real Account access requires separate approval by Risk Management, Trading Department, and Company Management. | 7 | CONFIRMED |
| D-044 | First payout: 21 calendar days + ≥7 trading days. Subsequent: every 15 calendar days + ≥7 trading days. Minimum $50. No guaranteed instant payout. Full trade-history review. No arbitrary cancellation of compliant traders' profits. | 8 | CONFIRMED |

### A.6 Real Accounts, Distribution & Scaling

| ID | Decision | Brief § | Status |
|---|---|---|---|
| D-050 | Real Accounts: max overall loss 10%; max risk per trade 2%; one open position per asset/account; max position notional 10%; min holding 2 minutes; no mandatory overnight/weekend close; no mandatory stop-loss. | 9 | CONFIRMED |
| D-051 | Daily drawdown equity-based, resets 00:00 UTC; limit value not yet specified. | 9 | CONFIRMED (value UNRESOLVED) |
| D-052 | Overall drawdown static from initial capital, equity-based. | 9 | CONFIRMED |
| D-053 | BUY opens; Close Position closes; sizing in shares or USD notional; breaches trigger automatic enforcement and position closure. | 9 | CONFIRMED |
| D-054 | Real Account scaling may reach $5,000,000; stages and reserve thresholds unresolved. | 9 | CONFIRMED (stages UNRESOLVED) |
| D-055 | Profit split per $100: $70 trader / $10 trader reserve / $20 company (to company risk reserve); then 80/20 after reserve threshold. | 10 | CONFIRMED |
| D-056 | $100,000 Real Account: scaling reserve target $24,000; may scale to $200,000. No further thresholds to be invented. | 10 | CONFIRMED |
| D-057 | Exit process: close positions, reconcile, deduct liabilities from trader reserve, return remainder per existing policy. | 10 | CONFIRMED |
| D-058 | If company reserve is insufficient, company bears residual loss; trader owes nothing further. | 10 | CONFIRMED |

### A.7 Future Modules

| ID | Decision | Brief § | Status |
|---|---|---|---|
| D-060 | Investor Copy Trading is a future separate module; not in initial MVP; requires legal, regulatory, liquidity, operational review. Parameters as listed in BUSINESS_PLAN H.1. | 11 | CONFIRMED |
| D-061 | Global Competition is a planned acquisition feature with parameters as listed in BUSINESS_PLAN H.2; winners must still complete the normal Challenge; implementation priority not finalised. | 12 | CONFIRMED (priority UNRESOLVED) |

### A.8 Technology, Scale, Security

| ID | Decision | Brief § | Status |
|---|---|---|---|
| D-070 | Responsive web + installable PWA; no native mobile or Electron for MVP; professional dark institutional UI. | 13 | CONFIRMED |
| D-071 | React is a candidate only; Railway and Vercel are candidate hosts; GitHub is source control. | 13 | CONFIRMED. React remains UNRESOLVED (OQ-070). The host split is D-077 |
| D-072 | Real market data required; data feed and broker execution are separate; realistic simulation (spread, liquidity, slippage, partial fills, sessions). | 13 | CONFIRMED |
| D-073 | Binance public WebSocket possible for crypto; US equities provider after licensing/redistribution review; no fabricated prices; explicit stale/disconnected status. | 13 | CONFIRMED |
| D-074 | Initial ~1,000 registered traders; growth toward ~10,000; do not assume all are concurrently active; prepare performance and load-testing strategy. | 14 | CONFIRMED |
| D-075 | Security essential from the beginning, covering the fourteen areas in SECURITY_REQUIREMENTS §1; never store credentials in GitHub source. | 15 | CONFIRMED |
| D-076 | Copy trading is prohibited for Challenge and Funded Simulation. A confirmed violation blocks the affected account automatically. Similar trades alone are not sufficient; multiple independent signals and retained evidence are required. 100% detection is not guaranteed. Recorded from the 2026-11-14 correction task. The detection engine is not implemented. | Correction task §6 | CONFIRMED |
| D-077 | Vercel hosts the frontend (`apps/web`): public site, trader terminal, dashboard, admin panel, routing, static assets, CDN, and preview deployments. Railway hosts the backend: API, authentication, challenge and account management, market-data engine, WebSocket servers, trading engine, risk engine, background workers, and later payments and ledger. The two deploy independently. WebSocket connections go to Railway. Secrets stay out of GitHub and the frontend bundle. Server-side secrets stay on the backend. Railway services are logically separable and are not forced into one process. PostgreSQL placement and backups are decided separately. Cost and limits are monitored. The architecture is designed with 10,000 concurrent active users in mind, and that capacity is not claimed until a load test passes. | Hosting decision 2026-11-13 | CONFIRMED. Domain, plans, region, and backup retention remain PROPOSED (P-017 to P-019) |

---

## Part B — Pending Recommendations (PROPOSED, not approved)

| ID | Recommendation | Rationale | Related | Status |
|---|---|---|---|---|
| P-001 | Adopt a single written drawdown specification (equity-based, explicit reference points, worked examples) for all account types. | Prevents disputes and engine ambiguity. | OQ-001, D-025 | PROPOSED |
| P-002 | Define "trading day" as a UTC calendar day with at least one executed opening trade. | Needed for 7-day minimum and payouts. | OQ-002 | PROPOSED |
| P-003 | Launch MVP with a single market first (candidate: crypto, owing to free public data; or equities if Real Account path is the priority). | Reduces licensing and engineering scope. | OQ-020 | PROPOSED |
| P-004 | Hybrid hosting: PWA on a CDN-oriented platform; long-running data/risk/execution services and database on a container platform. | Serverless platforms poorly suit persistent WebSockets and stateful engines. | OQ-071 | ACCEPTED 2026-11-13 by D-077. Domain, region, plans, and backups remain P-017 to P-019 |
| P-005 | Use React (with a mature framework) for the PWA. | Ecosystem, charting, hiring. | OQ-070 | PROPOSED |
| P-006 | PostgreSQL as primary store with exact decimal money and append-only double-entry ledger. | Financial integrity. | DATABASE_SCHEMA | PROPOSED |
| P-007 | Modular monolith plus dedicated engine processes, not microservices, for 1K–10K traders. | Lower operational risk. | TECHNICAL_ARCHITECTURE §2 | PROPOSED |
| P-008 | Block new opening orders on STALE instruments. | Prevents stale-price exploitation. | OQ-045 | PROPOSED |
| P-009 | KYC mandatory before first payout and Real Account. | AML and fraud. | OQ-080 | PROPOSED; REQUIRES LEGAL REVIEW |
| P-010 | Four-eyes approval for payouts above a threshold and for all manual ledger adjustments. | Insider risk. | SECURITY §4 | PROPOSED |
| P-011 | Forced breach closures bypass the 2-minute minimum holding period. | Risk limits must prevail. | OQ-042 | PROPOSED |
| P-012 | Measure 2% per-trade risk as a defined function of position notional and a configured adverse move (or require a protective stop only for sizing calculation). | Makes BR-402 enforceable without mandatory stops. | OQ-041 | PROPOSED |
| P-013 | Keep Global Competition out of MVP; reconsider after Challenge launch and US equities data costs are known. | Data licensing cost scales with free users. | OQ-061 | PROPOSED |
| P-014 | Replace the $300K competition prize with an existing size or reinstate $300K as a prize-only size — founder to choose. | Resolves contradiction. | OQ-060 | PROPOSED (options only) |
| P-015 | Rule-set versions are immutable and bound to an account at purchase. | Fairness and auditability. | FR-081 | PROPOSED; REQUIRES LEGAL REVIEW |
| P-016 | Obtain a written regulatory opinion before accepting payments. | Regulatory exposure. | OQ-080 | PROPOSED |
| P-017 | One firm-owned registrable domain. Web at `app.<domain>`, API and WebSocket at `api.<domain>`, staging on `app.staging.<domain>` and `api.staging.<domain>`. Cookie `Domain=<domain>`, `SameSite=Lax`, `Secure` outside development. Do not use `*.vercel.app` with `*.railway.app` as the cookie site. | Module 02 cookies are host-only and are set through the same-origin `/k2-api` proxy. Split platform hostnames cannot share them, so the browser cannot authenticate a direct Railway WebSocket. | D-077 | PROPOSED. Blocked on the domain name. `COOKIE_DOMAIN` is not implemented |
| P-018 | PostgreSQL on Railway private networking, in a region the founder chooses. Pro plan (confirm on the account) so volume backups and point-in-time recovery exist. Daily, weekly, and monthly volume backups, PITR, plus an encrypted `pg_dump` outside the project. Quarterly restore drill. No production data in staging or preview. | Trial volumes are disposable and restores stay inside one Railway project. | D-077, OQ-084 | PROPOSED |
| P-019 | Buy Vercel Pro or Enterprise before creating a project. Hobby forbids commercial use. Buy a Railway plan with a custom domain and backups before any database that must be kept. Set spend caps on both. | K2 is a commercial product. The published trial is $5 for 30 days and then deletes stateful volumes. | D-077 | PROPOSED. Blocked on the purchase |
| P-020 | Keep the market-data engine inside the one API replica until a listed trigger: more than one replica, a load test that shows fan-out delaying the API, a second consumer that needs the feed, or the first background job (worker only). Do not add Redis or Kafka before that trigger. | Requirement 7 forbids a permanent forced monolith. Splitting now has no measured need and was out of scope. | D-077 | PROPOSED as the trigger list. The split itself is not approved and was not done |

## Part C — Change Procedure (PROPOSED)

1. Change request references the affected BR/D/P/OQ IDs.
2. Impact analysis (ledger, risk, legal, customer communication).
3. Founder approval recorded with date.
4. New rule-set version created; existing accounts unaffected unless explicitly decided and disclosed.
5. Documentation updated in the same change.
