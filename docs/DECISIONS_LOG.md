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
| D-077 | Vercel hosts the frontend (`apps/web`): public site, trader terminal, dashboard, admin panel, routing, static assets, CDN, and preview deployments. Railway hosts the backend: API, authentication, challenge and account management, market-data engine, WebSocket servers, trading engine, risk engine, background workers, and later payments and ledger. The two deploy independently. WebSocket connections go to Railway. Secrets stay out of GitHub and the frontend bundle. Server-side secrets stay on the backend. Railway services are logically separable and are not forced into one process. PostgreSQL placement and backups are decided separately. Cost and limits are monitored. The architecture is designed with 10,000 concurrent active users in mind, and that capacity is not claimed until a load test passes. | Hosting decision 2026-11-13 | CONFIRMED. Domain, plans, and backup retention remain PROPOSED (P-017 to P-019). Region is D-078 |
| D-078 | The K2 Railway backend region is EU West, Amsterdam (`europe-west4`). The API service and the Postgres database each run as exactly one replica in that one region. The reason is that Binance blocks US IP addresses. Data residency for that backend and database is the EU / Netherlands. Railway's EU West Metal region (`europe-west4-drams3a`) is preferred. The first deploy must smoke-test Binance from the region that actually runs; HTTP 451 or 403 means that region is blocked. On 2026-11-21 the live project `overflowing-charm` had services `@k2/api` and `@k2/web` and no service instances or deployments in production, so nothing running had to be moved. This entry records the repository configuration only. It was not applied and nothing was deployed. | Founder decision 2026-11-21 | CONFIRMED. Domain, plans, and backup retention remain PROPOSED |

---

## Part B — Pending Recommendations (PROPOSED, not approved)

| ID | Recommendation | Rationale | Related | Status |
|---|---|---|---|---|
| P-001 | Adopt a single written drawdown specification (equity-based, explicit reference points, worked examples) for all account types. | Prevents disputes and engine ambiguity. | OQ-001, D-025 | PROPOSED |
| P-002 | Define "trading day" as a UTC calendar day with at least one executed opening trade. | Needed for 7-day minimum and payouts. | OQ-002 | PROPOSED |
| P-003 | Launch MVP with a single market first (candidate: crypto, owing to free public data; or equities if Real Account path is the priority). | Reduces licensing and engineering scope. | OQ-020 | PROPOSED |
| P-004 | Hybrid hosting: PWA on a CDN-oriented platform; long-running data/risk/execution services and database on a container platform. | Serverless platforms poorly suit persistent WebSockets and stateful engines. | OQ-071 | ACCEPTED 2026-11-13 by D-077. Region is D-078. Domain, plans, and backups remain P-017 to P-019 |
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
| P-018 | PostgreSQL on Railway private networking, in EU West, Amsterdam (`europe-west4`, D-078). Pro plan (confirm on the account) so volume backups and point-in-time recovery exist. Daily, weekly, and monthly volume backups, PITR, plus an encrypted `pg_dump` outside the project. Quarterly restore drill. No production data in staging or preview. | Trial volumes are disposable and restores stay inside one Railway project. | D-077, D-078, OQ-084 | PROPOSED for the plan and backups. The region is CONFIRMED |
| P-019 | Buy Vercel Pro or Enterprise before creating a project. Hobby forbids commercial use. Buy a Railway plan with a custom domain and backups before any database that must be kept. Set spend caps on both. | K2 is a commercial product. The published trial is $5 for 30 days and then deletes stateful volumes. | D-077 | PROPOSED. Blocked on the purchase |
| P-020 | Keep the market-data engine inside the one API replica until a listed trigger: more than one replica, a load test that shows fan-out delaying the API, a second consumer that needs the feed, or the first background job (worker only). Do not add Redis or Kafka before that trigger. | Requirement 7 forbids a permanent forced monolith. Splitting now has no measured need and was out of scope. | D-077 | PROPOSED as the trigger list. The split itself is not approved and was not done |

## Part C — Module 05 implementation record (not a new founder decision)

Recorded 2026-11-27. Approved decisions A–N are unchanged. This is status, not a new rule.

| Item | Record |
|---|---|
| M-05 simulation | COMPLETE for the simulated equity engine and Binance Spot USDT crypto. |
| USDT | 1 USDT settles as 1 USD. Crypto buys skip the equity calendar. |
| Catalogue | All Binance Spot USDT pairs. No minimum-volume filter. |
| Commission | 0.5 percent on the crypto opening buy. Close stays zero. |
| Scaling in | Still rejected (`POSITION_ALREADY_OPEN`). |
| Production fills | Remain off. `EXECUTION_ENABLED` is allowed only when `APP_ENV=development`. |
| Live execution | The M-06 engine is implemented for the simulation. The server process still uses the fail-closed authorizer, so a buy is still rejected until that process is switched. No broker and no real-money path was added. |

## Module 06 founder decisions — 2026-11-27

These decisions are from the founder on 2026-11-27. They apply to Challenge and Funded Simulation evaluation. Real Account daily-loss value (D-051, OQ-040) stays unresolved. Approved decisions A–N are otherwise unchanged.

| Topic | Decision |
|---|---|
| Daily loss floor | 0.95 times the highest equity of the UTC day. Equity is cash plus open longs marked at the bid. A new `EQUITY_HIGH` row is inserted only when equity sets a strict new high. The day-open mark is the first evaluation after 00:00 UTC. It does not wait for a timer. There is no tick filter: equity is money at scale 4, and a tick filter would drop a real high on a small position. |
| Max drawdown | Unchanged. 0.92 times the initial balance. The floor does not rise. |
| Breach | Equity less than or equal to either floor. The account becomes `FAILED`. Free quantity is sold with a risk-reducing market order. A closed equity calendar and a stale feed do not block that sell. One account gets one breach row, so two quotes cannot sell the same quantity twice. |
| Pending buys | Every working buy is treated as filled before a new buy is allowed. A limit uses its limit price. A market buy uses the ask. An entry-stop buy uses the higher of the stop and the ask. Pending sells, closes, stop-losses, and take-profits are not counted. The account row lock serializes concurrent buys. |
| Stage result | Stage 1 target is 8 percent and Stage 2 is 5 percent, both on closed balance, with at least 7 trading days and no open position. Stage 1 allows 30 calendar days from the first execution and Stage 2 allows 60. A pass writes `PASSED` and one `risk_stage_outcomes` row. It does not open a Stage 2 or Funded account. A timeout without the target is `FAILED` and force-closes like a breach. |
| Schema | No change to `trading_accounts` or `purchase_evidence`. Risk rows are append-only in migration `0013`. |

## Provisional — Module 07, awaiting founder (2026-11-27)

These are fail-closed defaults. They use no founder-chosen number. Each can be reversed by a later decision. They are not approved founder decisions.

| Topic | Provisional choice |
|---|---|
| Freeze lift | A reconciliation freeze stays until `liftLedgerFreeze` appends a lift row. Balances matching again does not lift it. |
| Severity bands | No production threshold. Every exact cash mismatch is `CRITICAL`. Absolute warning and critical bounds can be passed by a caller later. They are not implied. |
| Subscription accrual | Accrual runs only for `ACTIVE` accounts. `FAILED` and `PASSED` stop it. |
| Subscription versus equity | Unchanged and already required: a subscription row does not change the cash sum or equity. |
| Payments grace | Not implemented in Module 07. Module 08 writes an append-only human review when grace ends. There is no production day count. Unset configuration does not invent 3 or 7 days: the review row is written immediately. The account is not set to `FAILED` or `PAUSED`. |

## Part D — Change Procedure (PROPOSED)

1. Change request references the affected BR/D/P/OQ IDs.
2. Impact analysis (ledger, risk, legal, customer communication).
3. Founder approval recorded with date.
4. New rule-set version created; existing accounts unaffected unless explicitly decided and disclosed.
5. Documentation updated in the same change.
