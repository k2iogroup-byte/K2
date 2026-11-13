# K2 Group — Open Questions & Critical Risks

> **Phase:** Documentation-only foundation phase. Not production-ready.
> Every item below is **UNRESOLVED** or **REQUIRES LEGAL REVIEW** unless stated. "Proposed resolution" text is a recommendation only (PROPOSED) and **must not be treated as an approved decision**.
> Priority: **P0** = blocks MVP specification; **P1** = blocks a specific MVP module; **P2** = blocks a post-MVP module.

---

## Part 1 — Open Questions

### 1.1 Challenge Rules & Drawdown Precision

| ID | Question | Why it matters | Proposed resolution (PROPOSED) | Priority |
|---|---|---|---|---|
| OQ-001 | **Drawdown precision.** For Challenge (and Funded Simulation): is daily loss measured on equity or balance? Against start-of-day balance, start-of-day equity, or the higher of the two? When does the day reset (00:00 UTC as for Real Accounts, or another time)? Is the 8% max drawdown static from initial balance or trailing from peak? Equity or balance? | This is the single largest source of trader disputes in the prop-trading industry. A 5% daily limit against start-of-day equity vs balance can produce different breach outcomes for the same trades. The brief itself requires precise documentation before implementation (D-025). | Align with Real Account conventions already CONFIRMED: equity-based, static from initial capital, daily reset 00:00 UTC, with the daily reference = higher of start-of-day balance and equity. Provide founder-signed worked examples (open positions over midnight, gaps, commission). | P0 |
| OQ-002 | Definition of a "trading day" (min 7). | Affects stage pass and payout eligibility. Without a definition, a trader could place one tiny trade per day. | UTC calendar day with ≥1 executed opening trade; consider a minimum notional. | P0 |
| OQ-003 | Is the profit target met on balance (closed P&L) or equity? Must positions be closed? | Determines pass timestamp. | Balance-based target with all positions closed, plus 7 trading days met. | P0 |
| OQ-004 | Maximum duration (30/60 days): calendar or trading days? Clock starts at purchase, activation, or first trade? | Subscription starts at first trade; the duration clock may differ. | Calendar days from first executed trade, consistent with subscription. | P0 |
| OQ-005 | Stage 1 → Stage 2 transition: new account, reset balance, any fee, subscription cycle continuity? | Ledger and UX design. | New Stage 2 account at initial size, no extra fee, subscription continues on same cycle. | P0 |

### 1.2 Fees, Commission, Subscription

| ID | Question | Why it matters | Proposed resolution (PROPOSED) | Priority |
|---|---|---|---|---|
| OQ-010 | Subscription collection: card charge, debit from simulated account balance, or deduction from payouts? What on non-payment? | A debit from simulated balance would affect drawdown; card billing requires stored payment methods and dunning. | Real-money card charge via provider; account paused (not failed) on non-payment with a grace period. | P0 |
| OQ-011 | Do commission and subscription reduce Challenge equity for drawdown and target purposes? | Changes pass/fail outcomes. | Commission yes (trading cost), subscription no (billed separately). | P0 |
| OQ-012 | **Commission across markets.** Does 0.5% on opening BUY apply identically to equities, crypto, and forex? | The brief requires confirmation before implementation. In FX, every trade is simultaneously a buy and sell of currencies; "opening BUY" is ambiguous. 0.5% per open is very high for FX relative to typical market costs and may make FX Challenges unviable. | Founder to set per-market commission in the rule-set; document FX "opening" definition. | P0 |
| OQ-013 | Is short selling permitted (opening with SELL)? If yes, commission applies? The brief defines BUY as the opening action for Real Accounts. | Affects order model, crypto/FX usability, and commission revenue. | Founder decision; if long-only, state explicitly in the Rulebook. | P0 |
| OQ-014 | Refund, reset, and cancellation policy for Challenge purchases and subscriptions. | Consumer law and chargebacks. | Draft with counsel. REQUIRES LEGAL REVIEW. | P1 |

### 1.3 Market Scope

| ID | Question | Why it matters | Proposed resolution (PROPOSED) | Priority |
|---|---|---|---|---|
| OQ-020 | Which market(s) launch in MVP? Are Challenges per-market or multi-market accounts? | Drives data licensing, fill model, sessions, and schema. | Start with one market; per-market accounts. | P0 |

### 1.4 Funded Simulation & Payouts

| ID | Question | Why it matters | Proposed resolution (PROPOSED) | Priority |
|---|---|---|---|---|
| OQ-030 | Funded Simulation trading rules (daily loss, max drawdown, position limits). | The brief gives none; the engine cannot enforce undefined limits. | Founder to define; candidate is mirroring Challenge limits. | P0 |
| OQ-031 | **Funded Simulation payout split.** The 70/10/20 split is stated for master-account (Real) profit. What share of verified simulated profit is paid? | Core economics and trader communication. | Founder decision; do not reuse 70/10/20 by assumption. | P0 |
| OQ-032 | End state of Funded Simulation if Real Account is not approved, and for crypto/FX traders who can never get Real Accounts. | Customer expectations and fairness. | Define continuation, renewal, or closure policy. | P1 |
| OQ-033 | Must positions be closed before a payout? Does a payout reset drawdown reference levels? | Ledger and risk consistency. | Require flat positions; drawdown reference unchanged by payouts unless founder decides otherwise. | P1 |
| OQ-034 | Payout rails, currencies, fees, and SLA. | Regulatory and operational. | REQUIRES LEGAL REVIEW. | P1 |

### 1.5 Real Account Rules

| ID | Question | Why it matters | Proposed resolution (PROPOSED) | Priority |
|---|---|---|---|---|
| OQ-040 | **Real Account daily drawdown limit value.** The brief confirms basis (equity) and reset (00:00 UTC) but not the limit. | The engine cannot enforce an unspecified limit. Also: 00:00 UTC falls outside US regular session (approx. 13:30–20:00 UTC, depending on daylight saving), so the "day" spans after-hours and the next morning's gap. Overnight holdings are allowed, so gap risk at open can breach before any intervention. | Founder to set the value; confirm 00:00 UTC vs US session boundaries with worked gap examples. | P2 (P0 for Real phase) |
| OQ-041 | How is "max risk per trade 2%" measured without mandatory stop-loss? | Without a stop, risk is undefined; with 10% max notional, a 20% adverse move equals 2% of capital. | Define risk = notional × assumed adverse move parameter, or require a protective stop for sizing only. | P2 |
| OQ-042 | Does the 2-minute minimum holding period block forced breach closure? | Conflict between two CONFIRMED rules (BR-405 vs BR-411). | Forced closures override the holding period. | P2 |
| OQ-043 | With one open position per asset: is adding to a position, partial close, or fractional shares allowed? | Order model and UX. | Founder decision. | P2 |
| OQ-044 | Enforcement when the broker rejects, partially fills, or the stock is halted / market closed (overnight, weekends). | Automatic closure cannot be guaranteed outside sessions; losses may exceed 10%. | Document best-effort closure policy and loss waterfall application. | P2 |
| OQ-045 | Risk evaluation during data staleness: freeze, use last price, or use secondary source? | Erroneous breaches or missed breaches. | Freeze opening orders; continue risk with secondary source; flag decisions made under degraded data. | P0 |
| OQ-046 | Policy for reversing breaches caused by erroneous market data or platform faults. | Fairness, BR-355. | Documented review process with ledger-reversal entries. | P1 |

### 1.6 Profit Distribution & Scaling

| ID | Question | Why it matters | Proposed resolution (PROPOSED) | Priority |
|---|---|---|---|---|
| OQ-050 | **Scaling beyond $100K → $200K.** Only this step is confirmed ($24,000 reserve). Stages up to $5,000,000 and their thresholds are unresolved. Also: at $10 per $100, a $24,000 reserve requires ~$240,000 cumulative profit (240% of capital). Is this intended? | Long-term trader value proposition and company risk. | Founder to provide a full scaling table; validate with economic modelling. | P2 |
| OQ-051 | Is scaling automatic at the threshold or subject to review? | Workflow design. | Review-gated, consistent with BR-303 philosophy. | P2 |
| OQ-052 | The "existing policy" for returning the trader reserve on exit is not in the brief. | Cannot implement exit flow. | Founder to supply the policy text. | P2 |
| OQ-053 | Does the company share fund the risk reserve after the 80/20 switch? Is the company risk reserve per-trader or pooled? | Ledger structure and loss absorption. | Founder decision. | P2 |
| OQ-054 | Profit computation basis: per period, net of prior losses (high-water mark), net of commission and subscription? | Prevents paying profit twice after drawdowns. | High-water-mark net basis. | P2 |
| OQ-055 | Is the 80/20 switch threshold the same as the scaling reserve target? | Two thresholds may coincide or differ. | Founder clarification. | P2 |

### 1.7 Future Modules

| ID | Question | Why it matters | Proposed resolution (PROPOSED) | Priority |
|---|---|---|---|---|
| OQ-060 | **Contradiction:** Global Competition awards a $300K Challenge, but the $300,000 size was removed. | Prize cannot be fulfilled under current catalogue. | Founder to choose: replace prize or create a prize-only size. | P2 |
| OQ-061 | **Competition priority** relative to MVP. | Free stocks-only users drive US equities data licensing costs (often per-user) without revenue. | Keep out of MVP; revisit after licensing costs known. | P1 (planning) |
| OQ-062 | Competition ranking metric, tie-breaks, eligibility countries, prize expiry. | Fairness and legal. | REQUIRES LEGAL REVIEW. | P2 |
| OQ-065 | Investor Copy: settlement quarterly vs semiannual; limits on the 50% loss coverage; custodian selection; licensing. | Likely a regulated activity. | REQUIRES LEGAL REVIEW before any design. | P2 |

### 1.8 Technology & Vendors

| ID | Question | Why it matters | Proposed resolution (PROPOSED) | Priority |
|---|---|---|---|---|
| OQ-070 | **React confirmation.** React is a candidate, not confirmed. | Frontend hiring, charting library choice, PWA tooling. | Adopt React with a mature framework; founder to confirm. | P0 |
| OQ-071 | **Railway vs Vercel.** | Persistent WebSockets and stateful engines need long-running processes; serverless functions are a poor fit for those parts. | Hybrid: Vercel-type CDN for PWA, container platform (Railway or a major cloud) for engines and database. Evaluate SLAs, compliance attestations, regions. | P0 |
| OQ-072 | **Broker selection** for equities Real Accounts. | Determines execution API, account structure, fees (must not be assumed — D-033), reconciliation, jurisdictions. | Shortlist brokers offering institutional API access and sub-account structures; legal review of agreement. | P2 (P0 for Real phase) |
| OQ-073 | **US equities market-data licensing.** Display vs non-display use, per-user exchange fees, professional/non-professional classification, redistribution rights. | Fees may scale per user and can be material; unlicensed redistribution is a contractual and regulatory breach. | Engage vendors and counsel before selection. REQUIRES LEGAL REVIEW. | P0 if equities in MVP |
| OQ-074 | FX and secondary crypto data sources; Binance terms for redistribution and geographic restrictions. | Single-source dependency; terms compliance. | Evaluate at least two sources per market. REQUIRES LEGAL REVIEW. | P0 for chosen MVP market |
| OQ-075 | Payment processor. | Many processors restrict trading-related or evaluation products; chargeback exposure. | Shortlist providers that explicitly accept prop-firm evaluations. | P0 |
| OQ-076 | KYC/AML vendor. | Coverage of target countries; data residency. | Select after jurisdiction decision. | P1 |

### 1.9 Regulatory & Legal

| ID | Question | Why it matters | Priority |
|---|---|---|---|
| OQ-080 | **Regulatory characterisation** of the business in each target jurisdiction: are paid Challenges with payouts of simulated profits a regulated activity (e.g., investment services, gambling/gaming, consumer contracts)? | Regulators in several jurisdictions have scrutinised prop-firm models; marketing to retail traders adds consumer-protection obligations. REQUIRES LEGAL REVIEW. | P0 |
| OQ-081 | Legal structure of "company-funded Real Accounts": is the trader an employee, contractor, or account manager? Who holds the brokerage account? | Determines licensing, tax, and broker onboarding. REQUIRES LEGAL REVIEW. | P2 (P0 for Real phase) |
| OQ-082 | Operating entity, jurisdiction, tax treatment of payouts, and restricted countries list. | Payments, KYC, and terms. REQUIRES LEGAL REVIEW. | P0 |
| OQ-083 | Terms of Service, Rulebook, risk disclosures, and marketing language (no implication of guaranteed payouts or real-money trading in simulation). | Consumer protection. REQUIRES LEGAL REVIEW. | P0 |
| OQ-084 | Data protection regime and record-retention periods. | Schema and backup design. REQUIRES LEGAL REVIEW. | P1 |

---

## Part 2 — Critical Risks

| ID | Risk | Category | Impact | Likelihood | Mitigation (PROPOSED) |
|---|---|---|---|---|---|
| RISK-01 | Ambiguous drawdown formulas lead to disputed breaches and reputational damage. | Risk mgmt / legal | High | High (until OQ-001 closed) | Signed formula spec with worked examples; publish in Rulebook; replayable decisions. |
| RISK-02 | Real Account daily DD value undefined; 00:00 UTC reset misaligned with US sessions; overnight gaps exceed limits before enforcement. | Risk mgmt | High | Medium | Decide value (OQ-040); model gap scenarios; define loss waterfall application. |
| RISK-03 | Commission applied uniformly across markets is economically or definitionally unsound (FX "BUY"). | Product / financial | Medium–High | Medium | Per-market rule-set parameters; founder confirmation (OQ-012). |
| RISK-04 | US equities data licensing costs and redistribution terms; unlicensed display. | Licensing / legal | High | Medium | Licensing review before vendor selection; budget per-user fees; keep free competition out of MVP. |
| RISK-05 | Regulatory reclassification of the business model or of simulated-profit payouts. | Regulatory | Critical | Unknown | Pre-launch legal opinion; geo-restrictions; careful disclosures. |
| RISK-06 | Broker dependency for Real Accounts (API limits, rejects, outages, account structure). | Execution | High | Medium | Broker due diligence; reconciliation; failover and manual procedures. |
| RISK-07 | Scaling economics: ~$240K profit needed to reach $24K reserve; stages beyond $200K unknown; up to $5M exposure. | Financial | Medium | Medium | Economic modelling; founder-approved scaling table (OQ-050). |
| RISK-08 | Funded Simulation payouts with undefined split and rules create unbounded liability. | Financial | High | High (until OQ-030/031 closed) | Define rules and split; payout caps; reserve modelling. |
| RISK-09 | Simulation fill model unrealistic (too favourable) → traders exploit; or too harsh → complaints. | Execution / fairness | High | Medium | Versioned, calibrated fill model; publish methodology; monitor slippage statistics. |
| RISK-10 | Stale-data exploitation and latency arbitrage. | Fraud | High | Medium | Staleness blocking; timestamped decisions; behavioural detection. |
| RISK-11 | Account takeover leading to payout theft. | Security | High | Medium | MFA, step-up, destination cooling-off, KYC name match. |
| RISK-12 | Insider manipulation of balances or payouts. | Security | High | Low–Medium | Segregation of duties, dual control, immutable audit. |
| RISK-13 | Payment processor refusal or termination. | Operational | High | Medium | Pre-approval with processor; secondary provider. |
| RISK-14 | Investor Copy loss coverage (50%) creates guarantee-like liability and regulated activity. | Regulatory / financial | Critical | — (future) | Keep out of MVP; full legal review (OQ-065). |
| RISK-15 | Competition contradiction ($300K prize) and promotion-law exposure. | Product / legal | Medium | High | Resolve OQ-060; legal review OQ-062. |
| RISK-16 | Unrealistic delivery expectations for an institutional-grade platform across three markets. | Delivery | High | High | Single-market MVP; specification-first risk engine; gated phases. |
| RISK-17 | Hosting choice unsuited to persistent real-time workloads. | Technical | Medium | Medium | Hybrid hosting (OQ-071); load testing before launch. |
| RISK-18 | Scale assumptions (1K → 10K) unvalidated; reconnect storms, fan-out load. | Performance | Medium | Medium | Load and chaos testing per TECHNICAL_ARCHITECTURE §8. |

## Part 3 — Identified Contradictions & Ambiguities (summary)

1. $300K competition prize vs removed $300K size (OQ-060).
2. 2-minute minimum hold vs automatic breach closure (OQ-042).
3. 2% risk per trade vs no mandatory stop-loss (OQ-041).
4. "Per month" vs "every 30 days" subscription wording (BR-214).
5. "BUY opens positions" vs crypto/FX trading conventions and short selling (OQ-012, OQ-013).
6. 70/10/20 split defined for master (Real) accounts while Funded Simulation payouts are also promised (OQ-031).
7. Real Account max overall loss (10%) is looser than Challenge max drawdown (8%) — may be intended; confirm.
8. Daily reset at 00:00 UTC vs US equities session boundaries (OQ-040).

## Part 4 — Unnecessary Complexity to Avoid (PROPOSED)

- Building all three markets at launch.
- Microservices or event-streaming platforms before load justifies them.
- Investor Copy and Competition before core Challenge integrity is proven.
- Native or desktop apps (already excluded by founder).
