# K2 Group — Business Plan & Business Rules Register

> **Phase:** Documentation-only foundation phase. Not production-ready.
> **Source:** Founder brief `K2-MASTER-PLAN.txt` is the only business source. Anything not stated there is tagged PROPOSED, UNRESOLVED, or REQUIRES LEGAL REVIEW.
> **Tags:** CONFIRMED · PROPOSED · UNRESOLVED · REQUIRES LEGAL REVIEW (see [README](./README.md)).

---

## Part A — Company Overview

### A.1 Identity and Vision

| ID | Statement | Status |
|---|---|---|
| BR-001 | The company name is **K2 Group**. | CONFIRMED |
| BR-002 | K2 Group is being developed as an **international proprietary trading firm** and, in the long term, a broader financial group. | CONFIRMED |
| BR-003 | Brand philosophy: ambition, discipline, precision, resilience, and pursuing exceptionally difficult goals (inspired by the K2 mountain). | CONFIRMED |
| BR-004 | The platform must be a serious, institutional-quality trading platform, not a generic AI-generated trading application. | CONFIRMED |
| BR-005 | Initial customer segment: **retail traders purchasing trading Challenges**. | CONFIRMED |
| BR-006 | Accuracy, financial integrity, security, and auditability take priority over superficial speed. | CONFIRMED |

### A.2 Business Model Summary

K2 Group sells paid evaluation programs ("Challenges") to retail traders. Traders who pass a two-stage evaluation progress to a **Funded Simulation** phase in which they continue trading in a simulated environment and may receive company-funded payouts of verified simulated profits. A separate, discretionary review may grant selected traders access to a **Real Account** (equities only) funded with company capital, where profits are distributed between the trader, a trader reserve, and the company.

Revenue streams identified in the brief:

| Stream | Description | Status |
|---|---|---|
| Challenge fees | One-off price per Challenge account size. | CONFIRMED |
| Subscription | $1 per $1,000 of account size per 30 days, from the first executed trade. | CONFIRMED |
| Trading commission | 0.5% on opening BUY transactions. | CONFIRMED (cross-market applicability UNRESOLVED) |
| Company share of Real Account profit | 20% of master-account profit. | CONFIRMED |
| Investor Copy profit share (future) | 50% of Copy Account profit. | CONFIRMED as intent; REQUIRES LEGAL REVIEW; not MVP |

Cost and liability exposures identified in the brief:

| Exposure | Description | Status |
|---|---|---|
| Funded Simulation payouts | Company may pay verified simulation profits from its own funds. | CONFIRMED; REQUIRES LEGAL REVIEW |
| Real Account losses | Absorbed by trader reserve, then company reserve, then company; trader never owes additional money. | CONFIRMED |
| Investor loss coverage (future) | Company covers 50% of investor Copy losses within agreed limits. | CONFIRMED as intent; REQUIRES LEGAL REVIEW; not MVP |
| Market data licensing | US equities data must be licensed for display/redistribution. | REQUIRES LEGAL REVIEW |

### A.3 Strategic Market Policy

| ID | Market | Challenge | Funded Simulation | Real Account | Status |
|---|---|---|---|---|---|
| BR-010 | Equities | Yes | Yes | **Yes** | CONFIRMED |
| BR-011 | Crypto | Yes | Yes | No | CONFIRMED |
| BR-012 | Forex | Yes | Yes | No | CONFIRMED |
| BR-013 | Other markets | May be introduced progressively | — | — | CONFIRMED (no specific market decided) |
| BR-014 | Real Accounts are **exclusively for equities**. Non-equity markets may still receive company-funded payouts for verified Funded Simulation profits. | | | | CONFIRMED |
| BR-015 | The platform must be designed for future multi-market expansion without building every market at launch. | | | | CONFIRMED |
| BR-016 | Which market(s) launch first in the MVP. | | | | UNRESOLVED (see OQ-020) |

---

## Part B — Challenge Program

### B.1 Account Sizes and Prices

| ID | Account Size | Challenge Price | Price as % of Size | Status |
|---|---|---|---|---|
| BR-100 | $10,000 | $129 | 1.29% | CONFIRMED |
| BR-101 | $25,000 | $250 | 1.00% | CONFIRMED |
| BR-102 | $50,000 | $399 | 0.80% | CONFIRMED |
| BR-103 | $100,000 | $699 | 0.70% | CONFIRMED |
| BR-104 | $200,000 | $1,200 | 0.60% | CONFIRMED |

| ID | Rule | Status |
|---|---|---|
| BR-105 | Maximum Challenge size is **$1,000,000**. | CONFIRMED |
| BR-106 | Sizes and prices above $200,000 (up to $1,000,000) require further confirmation. | UNRESOLVED |
| BR-107 | The $5,000 and $300,000 account sizes are **removed**. | CONFIRMED |
| BR-108 | Currency of pricing (USD assumed from the "$" notation), taxes/VAT, regional pricing, discounts, coupons, refunds, and resets. | UNRESOLVED |
| BR-109 | Whether a failed Challenge may be retaken at the same or a discounted price ("reset"). | UNRESOLVED |

> **Analyst note (not a decision):** The percentage column is derived arithmetic only. It shows a declining price-to-size ratio; no pricing formula for larger sizes may be inferred from it.

### B.2 Two-Stage Evaluation Rules

| ID | Rule | Stage 1 | Stage 2 | Status |
|---|---|---|---|---|
| BR-120 | Profit target | 8% | 5% | CONFIRMED |
| BR-121 | Daily loss limit | 5% | 5% | CONFIRMED |
| BR-122 | Maximum total drawdown | 8% | 8% | CONFIRMED |
| BR-123 | Minimum trading days | 7 | 7 | CONFIRMED |
| BR-124 | Maximum duration | 30 days | 60 days | CONFIRMED |

| ID | Rule | Status |
|---|---|---|
| BR-125 | Passing both stages leads to **Funded Simulation**, not automatic Real Account access. | CONFIRMED |
| BR-126 | Drawdown calculations and enforcement must be precisely documented before implementation. | CONFIRMED (requirement) |
| BR-127 | Challenge daily-loss basis: balance vs equity; reference point (start-of-day balance, start-of-day equity, or higher of the two); reset time and time zone. | UNRESOLVED (OQ-001) |
| BR-128 | Challenge maximum-drawdown type: static from initial balance vs trailing (high-water); equity vs balance. | UNRESOLVED (OQ-001) |
| BR-129 | Definition of a "trading day" (calendar day with ≥1 executed trade? minimum trade size? per time zone?). | UNRESOLVED (OQ-002) |
| BR-130 | Whether profit target is measured on closed balance or equity, and whether open positions must be closed to pass. | UNRESOLVED (OQ-003) |
| BR-131 | Whether "days" in maximum duration are calendar days or trading days, and when the clock starts (purchase vs first trade). | UNRESOLVED (OQ-004) |
| BR-132 | Whether Stage 2 starts automatically on Stage 1 pass, the account balance is reset to initial size, and whether Stage 2 requires a new fee. | UNRESOLVED (OQ-005) |
| BR-133 | Consequence of a breach (hard fail vs soft) and whether open positions are force-closed at breach. | UNRESOLVED for Challenge (Real Accounts: CONFIRMED automatic closure, BR-411) |
| BR-134 | Prohibited strategies (e.g., latency arbitrage, hedging across accounts, news-trading restrictions, copy-trading between accounts). | UNRESOLVED |
| BR-135 | Whether commission and subscription debits reduce Challenge equity for drawdown purposes. | UNRESOLVED (OQ-011) |

**PROPOSED (recommendation only):** Adopt a single, written drawdown specification used across Challenge, Funded Simulation, and Real Accounts, with equity-based measurement, explicit reference timestamps, and worked examples approved by the founder before any engine work.

---

## Part C — Subscription, Commission, and Fees

| ID | Rule | Status |
|---|---|---|
| BR-200 | Subscription: **$1 per $1,000 of account size per month** (e.g., $100 per cycle for a $100,000 account). | CONFIRMED |
| BR-201 | The subscription starts with the **first executed trade**. | CONFIRMED |
| BR-202 | The subscription **repeats every 30 days**. | CONFIRMED |
| BR-203 | Subscription applies to **Challenge, Funded Simulation, and Real Accounts**. | CONFIRMED |
| BR-204 | Collection method (card charge vs debit from account balance vs deduction from payouts). | UNRESOLVED (OQ-010) |
| BR-205 | Consequence of failed subscription payment (grace period, suspension, fail). | UNRESOLVED |
| BR-206 | Proration on stage transitions, account failure, or scaling to a larger size; whether the cycle restarts at Stage 2 / Funded Simulation. | UNRESOLVED |
| BR-207 | Commission: **0.5% on opening BUY transactions**. | CONFIRMED |
| BR-208 | **No closing commission** under the current decision. | CONFIRMED |
| BR-209 | Whether identical commission applies to all markets (equities, crypto, forex). Must be confirmed before implementation. | UNRESOLVED (OQ-012) |
| BR-210 | **Swap is 0.** | CONFIRMED |
| BR-211 | Do not assume broker fees or market-specific charges. | CONFIRMED |
| BR-212 | Whether commission on Real Accounts is a K2 charge in addition to actual broker fees, and who bears broker fees. | UNRESOLVED |
| BR-213 | Whether short selling (opening with SELL) exists; if so, whether it carries commission. The brief defines BUY as the opening action. | UNRESOLVED (OQ-013) |
| BR-214 | Whether "per month" (BR-200) and "every 30 days" (BR-202) are the same billing cycle. Interpreted as a 30-day cycle; confirmation needed. | UNRESOLVED |

> **Analyst note:** 0.5% per opening trade is high relative to typical retail equity and FX cost levels. On a $100,000 account, opening a single full-notional position costs $500. Combined with a 5% daily loss limit and 8% total drawdown, commission materially affects strategy viability and must be clearly disclosed. This is an observation, not a pricing recommendation.

---

## Part D — Funded Simulation

| ID | Rule | Status |
|---|---|---|
| BR-300 | Funded Simulation lasts **approximately 4–5 months**; this is **not** a guaranteed fixed period. | CONFIRMED |
| BR-301 | Traders are evaluated on profitability, risk management, discipline, consistency, and trading history. | CONFIRMED |
| BR-302 | The company **may** pay verified simulation profits using its own funds. | CONFIRMED; REQUIRES LEGAL REVIEW |
| BR-303 | Real Account access requires a **separate review and approval** by Risk Management, Trading Department, and Company Management. | CONFIRMED |
| BR-304 | Funded Simulation trading rules (daily loss, max drawdown, position limits). The brief does not state them. | UNRESOLVED (OQ-030) |
| BR-305 | Funded Simulation payout split (the 70/10/20 split is defined for "master-account profit", i.e., Real Accounts). | UNRESOLVED (OQ-031) |
| BR-306 | Quantitative scoring criteria for profitability, risk management, discipline, and consistency. | UNRESOLVED |
| BR-307 | What happens at the end of Funded Simulation if Real Account approval is not granted (or for crypto/forex traders, where Real Accounts do not exist). | UNRESOLVED (OQ-032) |
| BR-308 | Communication language must not imply that simulated profits are real trading profits or that payouts are guaranteed. | PROPOSED; REQUIRES LEGAL REVIEW |

---

## Part E — Payout Policy

| ID | Rule | Status |
|---|---|---|
| BR-350 | First payout eligibility: **21 calendar days and at least 7 trading days**. | CONFIRMED |
| BR-351 | Subsequent payout eligibility: **every 15 calendar days and at least 7 trading days**. | CONFIRMED |
| BR-352 | Minimum payout: **$50**. | CONFIRMED |
| BR-353 | **No guaranteed instant payout.** | CONFIRMED |
| BR-354 | All payout requests require **complete trade-history review**. | CONFIRMED |
| BR-355 | Compliant traders must **not** have profits arbitrarily cancelled. | CONFIRMED |
| BR-356 | Start of the 21-day clock (Funded Simulation activation vs first trade in Funded Simulation). | UNRESOLVED |
| BR-357 | Whether the 7 trading days for subsequent payouts are counted within the 15-day window or since the last payout. | UNRESOLVED |
| BR-358 | Payout methods (bank wire, card, crypto, payment provider), currencies, fees, processing SLA. | UNRESOLVED; REQUIRES LEGAL REVIEW |
| BR-359 | Whether open positions must be closed before a payout request, and the effect of a payout on drawdown reference levels. | UNRESOLVED (OQ-033) |
| BR-360 | Written, objective definitions of non-compliance that may justify withholding profits (to make BR-355 enforceable and auditable). | PROPOSED |
| BR-361 | KYC must be completed before first payout. | PROPOSED; REQUIRES LEGAL REVIEW |

---

## Part F — Real Accounts (Equities Only)

| ID | Rule | Status |
|---|---|---|
| BR-400 | Real Accounts are available **exclusively for equities**. | CONFIRMED |
| BR-401 | Maximum overall loss: **10%**. | CONFIRMED |
| BR-402 | Maximum risk per trade: **2% of account capital**. | CONFIRMED |
| BR-403 | **One open position per asset per account.** | CONFIRMED |
| BR-404 | Maximum individual position notional: **10% of account capital**. | CONFIRMED |
| BR-405 | Minimum holding period: **2 minutes**. | CONFIRMED |
| BR-406 | **No mandatory** overnight or weekend closing. | CONFIRMED |
| BR-407 | **No mandatory** stop-loss order. | CONFIRMED |
| BR-408 | Daily drawdown **limit value is not yet specified**. | UNRESOLVED (OQ-040) |
| BR-409 | Daily drawdown is **equity-based** and **resets at 00:00 UTC**. | CONFIRMED |
| BR-410 | Overall drawdown is **static from initial capital** and **equity-based**. | CONFIRMED |
| BR-411 | Breaches trigger **automatic enforcement and position closure**. | CONFIRMED |
| BR-412 | **BUY** opens positions; **Close Position** closes them. | CONFIRMED |
| BR-413 | Position sizing can be specified in **shares or USD notional**. | CONFIRMED |
| BR-414 | Real Account scaling may reach **$5,000,000**. | CONFIRMED |
| BR-415 | Exact scaling stages and reserve thresholds beyond the $100,000 → $200,000 step. | UNRESOLVED (OQ-050) |
| BR-416 | How "risk per trade" (2%) is measured when stop-loss orders are not mandatory (BR-407). | UNRESOLVED (OQ-041) |
| BR-417 | Whether the 2-minute minimum holding period blocks automatic breach closure (BR-411) or only trader-initiated closes. | UNRESOLVED (OQ-042) |
| BR-418 | Whether fractional shares, adding to an existing position (scaling in), and partial closes are permitted given BR-403 and BR-412. | UNRESOLVED (OQ-043) |
| BR-419 | Eligible equity universe (exchanges, listing venues, minimum price, liquidity filters, ETFs, extended hours). | UNRESOLVED |
| BR-420 | Broker/custodian for Real Accounts and the legal structure of the "company-funded" account. | UNRESOLVED; REQUIRES LEGAL REVIEW |

---

## Part G — Profit Distribution, Reserves, and Scaling

| ID | Rule | Status |
|---|---|---|
| BR-450 | Initial distribution of every $100 of master-account profit: **$70 trader payout, $10 trader accumulated reserve, $20 company share** allocated to company risk reserve. | CONFIRMED |
| BR-451 | After the trader reserve reaches the applicable threshold: **80% trader / 20% company**. | CONFIRMED |
| BR-452 | For a **$100,000** Real Account, the latest scaling reserve target is **$24,000**; at this point the account may scale to **$200,000**. | CONFIRMED |
| BR-453 | Do not invent further scaling thresholds. | CONFIRMED |
| BR-454 | On trader exit: open positions are closed, accounts reconciled, liabilities deducted from the trader reserve, and the remaining reserve returned according to the existing policy. | CONFIRMED |
| BR-455 | If the company reserve is insufficient to absorb a residual loss, the **company bears the remaining loss**; the trader **does not owe additional money**. | CONFIRMED |
| BR-456 | The "existing policy" for returning the trader reserve (timing, conditions, forfeiture cases) is not included in the brief. | UNRESOLVED (OQ-052) |
| BR-457 | Whether the $20 company share continues to fund the company risk reserve after the 80/20 split begins, and whether the company risk reserve is per-trader or pooled. | UNRESOLVED (OQ-053) |
| BR-458 | Whether profit is computed per payout period, net of losses since the last payout (high-water mark), and net of commission and subscription. | UNRESOLVED (OQ-054) |
| BR-459 | Loss waterfall order: trader reserve first, then company risk reserve, then company capital. | CONFIRMED as implied by BR-454/BR-455; exact mechanics UNRESOLVED |
| BR-460 | Whether "may scale" (BR-452) is automatic upon reaching the reserve target or subject to a further review. | UNRESOLVED (OQ-051) |
| BR-461 | Whether the reserve threshold for the 80/20 switch (BR-451) is the same value as the scaling reserve target (BR-452). | UNRESOLVED (OQ-055) |

**Worked arithmetic (derived from confirmed rules, for illustration only):** Under the 70/10/20 split, the trader reserve grows by $10 per $100 of profit. Reaching a $24,000 reserve therefore requires **$240,000 of cumulative master-account profit** on a $100,000 account — 240% of initial capital — assuming no reserve drawdowns from losses. The founder should confirm that this is the intended scaling pace (see OQ-050).

---

## Part H — Future Modules (Not MVP)

### H.1 Investor Copy Trading

| ID | Rule | Status |
|---|---|---|
| BR-500 | Future separate module; **not part of the initial MVP**. | CONFIRMED |
| BR-501 | Trader operates a company-funded Real Account master; investor has a separate Copy Account. | CONFIRMED (intent) |
| BR-502 | Investor minimum contribution: **$50,000**. | CONFIRMED (intent) |
| BR-503 | Investor and company split Copy Account profit **50/50**; trader receives no additional share of investor Copy profits. | CONFIRMED (intent) |
| BR-504 | Investor capital held with a **separate licensed broker/custodian**. | CONFIRMED (intent); REQUIRES LEGAL REVIEW |
| BR-505 | Company assigns traders and may replace them. | CONFIRMED (intent) |
| BR-506 | Copy settlement is quarterly or semiannual. | UNRESOLVED (choice between the two) |
| BR-507 | High-Water Mark applies. | CONFIRMED (intent) |
| BR-508 | Company covers 50% of investor losses, subject to agreed limits and settlement rules. | CONFIRMED (intent); REQUIRES LEGAL REVIEW |
| BR-509 | Module requires further legal, regulatory, liquidity, and operational review. | CONFIRMED; REQUIRES LEGAL REVIEW |

### H.2 Global Competition

| ID | Rule | Status |
|---|---|---|
| BR-550 | Planned customer-acquisition feature; implementation priority **not yet finalised**. | CONFIRMED / priority UNRESOLVED |
| BR-551 | Free participation; stocks only; 30 days; starting virtual capital $100,000. | CONFIRMED (intent) |
| BR-552 | Daily loss limit 1%; maximum total loss 3%. | CONFIRMED (intent) |
| BR-553 | One account per person; one global leaderboard; no reset or re-entry. | CONFIRMED (intent) |
| BR-554 | 79 prizes of free Challenge accounts: 1×$300K, 1×$200K, 2×$100K, 5×$50K, 20×$25K, 50×$10K. | CONFIRMED (intent); see BR-556 |
| BR-555 | Winners must still complete the normal Challenge; a prize does not grant an automatic funded or real account. | CONFIRMED |
| BR-556 | The **$300K** prize conflicts with the removal of the $300,000 account size (BR-107). | UNRESOLVED (OQ-060) |
| BR-557 | Free prize competitions may be regulated as sweepstakes/lotteries in some jurisdictions; eligibility and "one per person" require identity verification. | REQUIRES LEGAL REVIEW |
| BR-558 | Leaderboard ranking metric (return %, risk-adjusted) and tie-breaks. | UNRESOLVED |

---

## Part I — Go-to-Market Considerations (PROPOSED)

The following are recommendations, not founder decisions:

1. **PROPOSED:** Launch with a narrow product (one market, the five confirmed Challenge sizes) to prove rule enforcement accuracy and payment integrity before expanding.
2. **PROPOSED:** Publish a plain-language Rulebook generated from the same rule definitions used by the engine, so that marketing, terms, and enforcement cannot diverge.
3. **PROPOSED:** Obtain a regulatory opinion in each target jurisdiction before taking payments (REQUIRES LEGAL REVIEW).
4. **PROPOSED:** Model unit economics (Challenge pass rates, payout ratios, reserve adequacy) before finalising Funded Simulation payout splits and sizes above $200,000.

## Part J — Explicit Non-Assumptions

The following were deliberately **not** assumed: broker identity; payment processor; KYC vendor; legal entity and jurisdiction; tax treatment; Funded Simulation rules and payout split; Challenge drawdown method; leverage; short selling; instruments list; refund policy; scaling stages other than $100K → $200K; competition launch date.
