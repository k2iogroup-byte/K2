# K2 Group — MVP Scope (PROPOSED)

> **Phase:** Documentation-only foundation phase. Not production-ready.
> The MVP boundary below is a **PROPOSED** recommendation. Items explicitly excluded by the founder are marked CONFIRMED. Nothing in this document authorises implementation; it defines what the first build *would* contain once blocking questions are resolved.

---

## 1. MVP Objective (PROPOSED)

Deliver a secure, auditable platform on which retail traders can purchase a Challenge, trade in a realistic simulation powered by real market data, be evaluated precisely against the two-stage rules, progress to Funded Simulation, and request reviewed payouts — with every financial event recorded in an immutable ledger.

The MVP proves three things before any expansion: **rule-enforcement accuracy, payment and payout integrity, and operational security.**

## 2. Explicit Exclusions

| Item | Status | Basis |
|---|---|---|
| **Investor Copy Trading** | **OUT of MVP** | CONFIRMED (brief §11: "Do not implement it in the initial MVP"); REQUIRES LEGAL REVIEW |
| **Global Competition** | **OUT of MVP** | Priority UNRESOLVED in brief; exclusion PROPOSED and reflected in this scope; REQUIRES LEGAL REVIEW |
| Native mobile application | OUT | CONFIRMED |
| Electron desktop application | OUT | CONFIRMED |
| Challenge sizes above $200,000 | OUT until confirmed | CONFIRMED (require confirmation) |
| $5,000 and $300,000 sizes | Never offered | CONFIRMED (removed) |
| Real Account live trading with company capital | OUT of initial MVP; Phase 3 | PROPOSED (depends on broker, legal structure, OQ-040…044) |
| Profit distribution and scaling automation | Phase 3 | PROPOSED |
| Simultaneous launch of equities, crypto, and forex | OUT | PROPOSED (single-market launch, OQ-020) |
| PWA push notifications | Post-MVP | PROPOSED |

## 3. In Scope (PROPOSED)

### 3.1 Platform & Experience

| Capability | Rule basis | Status |
|---|---|---|
| Responsive web application, installable PWA | NFR-001 | CONFIRMED direction |
| Professional dark institutional UI | NFR-003 | CONFIRMED direction |
| Real-time charts using real market data; no fabricated prices | FR-020 | CONFIRMED |
| Explicit stale/disconnected feed status | FR-021 | CONFIRMED |
| Trader dashboard: accounts, rule meters, history, ledger view | FR-025 | PROPOSED |

### 3.2 Identity, Security, Compliance

| Capability | Status |
|---|---|
| Registration, email verification, MFA, session management | PROPOSED |
| RBAC and separate staff console with mandatory MFA | PROPOSED (RBAC CONFIRMED area) |
| KYC before first payout; sanctions screening | PROPOSED; REQUIRES LEGAL REVIEW |
| Anti-fraud baseline: duplicate identity, device signals, stale-price exploitation detection | PROPOSED (anti-fraud CONFIRMED area) |
| Secrets management with no credentials in GitHub | CONFIRMED |
| Immutable audit logs for orders, executions, risk decisions, admin actions | CONFIRMED area |

### 3.3 Challenge Program

| Capability | Status |
|---|---|
| Catalogue: $10K/$129, $25K/$250, $50K/$399, $100K/$699, $200K/$1,200 | CONFIRMED |
| Stage 1: 8% target, 5% daily loss, 8% max DD, ≥7 trading days, ≤30 days | CONFIRMED values; formulas UNRESOLVED (OQ-001…004) |
| Stage 2: 5% target, 5% daily loss, 8% max DD, ≥7 trading days, ≤60 days | CONFIRMED values; formulas UNRESOLVED |
| Pass both stages → Funded Simulation (not Real Account) | CONFIRMED |
| Versioned rule-sets bound to each account | PROPOSED |

### 3.4 Trading & Simulation

| Capability | Status |
|---|---|
| One launch market (to be chosen — OQ-020) | PROPOSED |
| Simulated execution with spread, liquidity, slippage, partial fills, sessions | CONFIRMED requirement |
| Market orders (other order types UNRESOLVED) | PROPOSED |
| BUY to open / Close Position (short selling UNRESOLVED, OQ-013) | CONFIRMED for Real; PROPOSED for MVP |
| Swap = 0 | CONFIRMED |
| Commission 0.5% on opening BUY; no closing commission | CONFIRMED (cross-market UNRESOLVED; only launch market needs confirmation for MVP) |

### 3.5 Billing

| Capability | Status |
|---|---|
| Challenge checkout via PCI-compliant hosted provider | PROPOSED (provider UNRESOLVED, OQ-075) |
| Subscription $1 per $1,000 per 30 days from first executed trade, on Challenge and Funded Simulation | CONFIRMED (collection method UNRESOLVED, OQ-010) |
| Refunds and chargeback handling | PROPOSED; REQUIRES LEGAL REVIEW |

### 3.6 Funded Simulation & Payouts

| Capability | Status |
|---|---|
| Funded Simulation account (~4–5 months, not fixed) with evaluation criteria | CONFIRMED; rules UNRESOLVED (OQ-030) |
| Payout eligibility: first 21 calendar days + ≥7 trading days; subsequent 15 calendar days + ≥7 trading days; min $50 | CONFIRMED |
| No instant payouts; full trade-history review; no arbitrary cancellation for compliant traders | CONFIRMED |
| Payout split for Funded Simulation | **UNRESOLVED — blocks payout launch** (OQ-031) |
| Company-funded payouts of verified simulated profits | CONFIRMED intent; REQUIRES LEGAL REVIEW |

### 3.7 Real Account Preparation (MVP-adjacent)

| Capability | Status |
|---|---|
| Three-party approval workflow (Risk, Trading, Management) recorded in admin console | CONFIRMED rule; PROPOSED for MVP inclusion |
| Real Account provisioning and live trading | Phase 3 (PROPOSED) |

### 3.8 Administration & Operations

| Capability | Status |
|---|---|
| Admin console: users, accounts, audit search, payout review/execution with segregation of duties, dual-approved ledger adjustments, rule-set approval | PROPOSED |
| Notifications: email and in-app for purchases, stage changes, warnings, breaches, subscription, payouts | PROPOSED |
| Support ticketing and dispute workflow | PROPOSED |
| Monitoring, alerting, backups, DR drills, status page | CONFIRMED areas; PROPOSED controls |

## 4. Scale Target for MVP

| Parameter | Target | Status |
|---|---|---|
| Registered traders at launch | ~1,000 | CONFIRMED |
| Growth headroom | Architecture allows ~10,000 without redesign | CONFIRMED |
| Concurrency assumption | 10–25% peak concurrent sessions; validated by load tests | PROPOSED |

## 5. Blocking Decisions for MVP Specification (must close before build)

| ID | Topic |
|---|---|
| OQ-001…OQ-005 | Challenge drawdown precision, trading-day definition, target basis, duration clock, stage transition |
| OQ-010, OQ-011 | Subscription collection; fee impact on equity |
| OQ-012, OQ-013 | Commission for the launch market; short selling |
| OQ-020 | Launch market |
| OQ-030, OQ-031 | Funded Simulation rules and payout split |
| OQ-045 | Risk behaviour during stale data |
| OQ-070, OQ-071 | React confirmation; Railway vs Vercel |
| OQ-073 / OQ-074 | Data licensing for the launch market |
| OQ-075 | Payment processor |
| OQ-080, OQ-082, OQ-083 | Regulatory opinion, entity/jurisdiction, terms and disclosures |

## 6. Launch Gates (PROPOSED)

The MVP must **not** be described as production-ready until all gates pass:

1. **Rules:** every CONFIRMED rule has founder-signed acceptance scenarios with worked numeric examples, and all pass.
2. **Ledger:** invariants verified (balanced entries, hash chain, reconciliation with payment provider) over a full staging cycle.
3. **Data:** feed outage drill shows correct STALE handling with no fabricated prices.
4. **Performance:** load test at ≥2× the expected launch concurrency with agreed latency targets met; reconnect-storm test passed.
5. **Security:** independent penetration test with no open critical/high findings; secret scanning clean; staff MFA enforced.
6. **Recovery:** backup restore drill within target RTO/RPO, followed by ledger verification.
7. **Legal:** written regulatory opinion, approved Terms, Rulebook, risk disclosures, privacy policy, and data-licence agreements.
8. **Operations:** on-call rota, incident runbooks, support processes, and payout review procedures in place.

## 7. Post-MVP Sequence (PROPOSED)

1. Funded Simulation payouts at scale (after OQ-031 and legal sign-off).
2. Real Accounts for equities (broker, legal structure, OQ-040…044).
3. Profit distribution 70/10/20 → 80/20 and scaling $100K → $200K (further stages after founder decision).
4. Additional markets.
5. Global Competition (if prioritised; after OQ-060/061/062).
6. Investor Copy Trading (only after full legal, regulatory, liquidity, and operational review).
