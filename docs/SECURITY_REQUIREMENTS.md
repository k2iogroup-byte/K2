# K2 Group — Security Requirements

> **Phase:** Documentation-only foundation phase for these requirements. Not production-ready.
> The brief states that **security is essential from the beginning** (CONFIRMED). The security *areas* below are CONFIRMED from the brief §15; the specific *controls* are PROPOSED unless noted.
>
> **Module 01** implemented only the foundation controls listed in [ARCHITECTURE_DECISIONS.md](./ARCHITECTURE_DECISIONS.md) (headers, CORS, validation, centralized errors, redacted structured logs, secret handling, dependency audit). The controls in the tables below are not implemented and remain PROPOSED. Module 01 does not make the application secure.

---

## 1. Confirmed Security Scope (from the brief)

| ID | Area | Status |
|---|---|---|
| SEC-A01 | Secure authentication | CONFIRMED |
| SEC-A02 | Role-based permissions | CONFIRMED |
| SEC-A03 | Admin access controls | CONFIRMED |
| SEC-A04 | Secrets management | CONFIRMED |
| SEC-A05 | Payment integrity | CONFIRMED |
| SEC-A06 | Immutable financial ledger events | CONFIRMED |
| SEC-A07 | Order and execution audit logs | CONFIRMED |
| SEC-A08 | Market-data timestamps | CONFIRMED |
| SEC-A09 | Anti-fraud controls | CONFIRMED |
| SEC-A10 | Backups and recovery | CONFIRMED |
| SEC-A11 | Monitoring and incident management | CONFIRMED |
| SEC-A12 | Rate limiting | CONFIRMED |
| SEC-A13 | Protection against unauthorised account access | CONFIRMED |
| SEC-A14 | Never store API keys, passwords, or private credentials in GitHub source code | CONFIRMED |

## 2. Threat Model Summary (PROPOSED)

| Threat | Example | Primary controls |
|---|---|---|
| Account takeover | Credential stuffing, phishing, SIM swap | MFA (TOTP/passkeys), breached-password checks, device/session alerts, rate limits |
| Payout fraud | Takeover then payout to attacker destination | Step-up MFA, payout destination cooling-off period, KYC name matching, manual review |
| Multi-accounting / rule abuse | Same person with many identities, opposing trades across accounts | KYC, device fingerprinting, correlation analytics, IP intelligence |
| Insider abuse | Staff altering balances or approving own payouts | RBAC, four-eyes, no direct DB writes, immutable audit, segregation of duties |
| Payment fraud | Stolen cards, chargebacks after payout | Provider risk tools, 3-D Secure, chargeback-linked holds |
| Market-data manipulation / latency exploitation | Exploiting stale feeds or delayed prices | Staleness blocking, timestamped decisions, latency-arbitrage detection |
| API abuse | Bots, scraping, order flooding | Rate limiting, bot protection, per-account order throttles |
| Supply chain | Malicious dependency | Lockfiles, dependency scanning, pinned versions, review |
| Secret leakage | Keys committed to GitHub | Secret scanning, pre-commit hooks, managed secret store, rotation |
| Data breach | Exfiltration of PII/KYC | Encryption, minimisation, vendor-held KYC documents, access logging |

## 3. Authentication (PROPOSED controls)

| ID | Requirement |
|---|---|
| SEC-001 | Passwords hashed with a memory-hard algorithm (e.g., Argon2id) with per-user salt; minimum length 12; checked against known-breached password lists. |
| SEC-002 | MFA available for all traders; **mandatory** for all staff, payout requests, payout destination changes, and Real Account holders. Passkeys/WebAuthn preferred; TOTP supported; SMS discouraged. |
| SEC-003 | Session tokens short-lived; refresh tokens rotated with reuse detection; HttpOnly, Secure, SameSite cookies; CSRF protection on state-changing requests. |
| SEC-004 | Login throttling and progressive delays per account and per IP; generic error messages to prevent enumeration. |
| SEC-005 | New-device and new-location login notifications; user-visible session list with remote revocation. |
| SEC-006 | Password reset revokes all sessions and notifies the user. |

## 4. Authorisation & Admin Access (PROPOSED controls)

| ID | Requirement |
|---|---|
| SEC-010 | RBAC with least privilege; roles: TRADER, SUPPORT, RISK, TRADING_REVIEW, MANAGEMENT, FINANCE, COMPLIANCE, ADMIN. |
| SEC-011 | Object-level authorisation on every request (ownership checks) to prevent IDOR. |
| SEC-012 | Staff console on a separate origin, accessible only via SSO with hardware-backed MFA, optionally IP/device restricted. |
| SEC-013 | **Segregation of duties:** the person who reviews a payout cannot execute it; the person who proposes a ledger adjustment cannot approve it; Real Account approval requires three distinct departments (CONFIRMED BR-303). |
| SEC-014 | No staff member has direct write access to production financial tables; all changes go through audited application workflows. Break-glass access is time-boxed, dual-approved, and fully logged. |
| SEC-015 | Quarterly access reviews; immediate de-provisioning on staff exit. |

## 5. Secrets Management

| ID | Requirement | Status |
|---|---|---|
| SEC-020 | No API keys, passwords, or private credentials in GitHub source code. | CONFIRMED |
| SEC-021 | Secrets held in the hosting platform's encrypted secret store or a dedicated secrets manager; injected at runtime. | PROPOSED |
| SEC-022 | Repository secret scanning and push protection enabled; pre-commit scanning recommended. | PROPOSED |
| SEC-023 | Separate secrets per environment; production secrets accessible only to production runtime and a minimal set of operators. | PROPOSED |
| SEC-024 | Rotation schedule for all credentials (broker, data vendors, payment provider, database); immediate rotation on suspected exposure. | PROPOSED |
| SEC-025 | Broker execution credentials isolated to the Broker Execution Adapter's runtime only. | PROPOSED |

## 6. Payment Integrity (PROPOSED controls)

| ID | Requirement |
|---|---|
| SEC-030 | Card data never touches K2 servers; use a PCI DSS–compliant hosted checkout to minimise PCI scope. |
| SEC-031 | Prices are determined server-side from the catalogue version; client-supplied amounts are ignored. |
| SEC-032 | Account provisioning only after verified, signed provider webhook; webhooks processed idempotently with replay protection. |
| SEC-033 | Daily reconciliation of provider settlements against ledger; discrepancies raise incidents. |
| SEC-034 | Chargebacks automatically place related accounts and pending payouts on hold for review. |

## 7. Financial Ledger Integrity

| ID | Requirement | Status |
|---|---|---|
| SEC-040 | Financial ledger events are immutable. | CONFIRMED |
| SEC-041 | Double-entry with balanced entries enforced at write time. | PROPOSED |
| SEC-042 | Hash-chained journal entries with periodic anchoring (e.g., signed daily checkpoint stored in write-once storage) to make tampering evident. | PROPOSED |
| SEC-043 | Corrections only via reversing/compensating entries with reason and dual approval. | PROPOSED |
| SEC-044 | Simulated and real-money books strictly separated; payouts are real-money entries referencing simulated results. | PROPOSED |

## 8. Order, Execution & Market-Data Audit

| ID | Requirement | Status |
|---|---|---|
| SEC-050 | Order and execution audit logs. | CONFIRMED |
| SEC-051 | Market-data timestamps. | CONFIRMED |
| SEC-052 | Every order records client-submitted, server-received, risk-decided, and executed timestamps. | PROPOSED |
| SEC-053 | Every fill and risk decision references the exact quote snapshot (source, source_ts, received_ts) and model/rule version used. | PROPOSED |
| SEC-054 | Clock synchronisation (NTP/PTP) monitored on all engine hosts; drift alerts. | PROPOSED |
| SEC-055 | Audit logs append-only, access-logged, and retained for the statutory period (REQUIRES LEGAL REVIEW). | PROPOSED |

## 9. Anti-Fraud (PROPOSED controls)

| ID | Requirement |
|---|---|
| SEC-060 | KYC before first payout and before Real Account; sanctions/PEP screening (REQUIRES LEGAL REVIEW for jurisdictions). |
| SEC-061 | Duplicate-identity detection across KYC data, payment instruments, devices, and IPs. |
| SEC-062 | Behavioural detection: correlated/opposing trades across accounts, latency arbitrage on stale quotes, copy-trading between unrelated accounts, abnormal fill exploitation. |
| SEC-063 | Payout destination must match verified identity; destination changes trigger a cooling-off period. |
| SEC-064 | Fraud findings must reference documented rules so that compliant traders' profits are not arbitrarily cancelled (CONFIRMED BR-355). |

## 10. Rate Limiting & Abuse Protection (PROPOSED controls)

| ID | Requirement |
|---|---|
| SEC-070 | Tiered rate limits: authentication (strict), payouts (strict), order entry (per account and per user), market-data subscriptions (per connection). |
| SEC-071 | Bot protection on registration, login, and checkout. |
| SEC-072 | WebSocket connection caps per user; message size and frequency limits. |
| SEC-073 | DDoS protection at the edge/CDN layer. |

## 11. Data Protection (PROPOSED; REQUIRES LEGAL REVIEW)

- Encryption in transit (TLS 1.2+; HSTS) and at rest for all data stores and backups.
- Field-level encryption for sensitive PII; KYC documents preferably held by the KYC vendor with K2 storing references only.
- Data minimisation and retention schedules aligned with applicable privacy laws (e.g., GDPR where relevant) — to be confirmed by counsel.
- Data subject request process compatible with financial record-keeping obligations.

## 12. Backups & Recovery (PROPOSED)

| ID | Requirement |
|---|---|
| SEC-080 | Continuous point-in-time recovery for the primary database; RPO ≤ 5 min (PROPOSED target). |
| SEC-081 | Encrypted backups copied to a separate account/region; immutable retention window to resist ransomware. |
| SEC-082 | Documented restore runbook; quarterly restore drills with measured RTO (≤ 1 hour PROPOSED). |
| SEC-083 | After restore, ledger hash-chain verification and broker/payment reconciliation before re-enabling trading. |

## 13. Monitoring & Incident Management (PROPOSED)

| ID | Requirement |
|---|---|
| SEC-090 | Centralised structured logging, metrics, and tracing; no secrets or full PII in logs. |
| SEC-091 | Alerts on: feed staleness, risk-engine lag, ledger imbalance, reconciliation mismatch, abnormal payout volume, authentication anomalies, admin privilege use. |
| SEC-092 | Incident severity levels, on-call rotation, defined response times, post-incident reviews. |
| SEC-093 | Customer-facing status page including market-data feed status. |
| SEC-094 | Trader-impacting incidents (e.g., erroneous breach due to bad data) have a documented review and remediation policy (policy UNRESOLVED, OQ-046). |

## 14. Secure Development (PROPOSED)

- Protected branches, mandatory code review, CI security checks (static analysis, dependency and container scanning).
- Threat modelling for each module before implementation.
- Independent penetration test before public launch and before Real Account go-live.
- Security acceptance criteria included in the MVP launch gates (see MVP_SCOPE.md).

## 15. Compliance Dependencies (REQUIRES LEGAL REVIEW)

Licensing status of the business model, AML/KYC obligations, data protection regime, market-data licence terms, payment provider acceptable-use policies for prop-trading/evaluation products, and record-retention periods.
