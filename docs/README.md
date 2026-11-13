# K2 Group — Platform Documentation (Foundation Phase)

> **Module 01 update (2026-11-13).** The founder specification *Module 01: Project Foundation* authorized a technical foundation: a separate frontend and backend, PostgreSQL migrations, CI, and the security baseline described in [ARCHITECTURE_DECISIONS.md](./ARCHITECTURE_DECISIONS.md). That work does not implement authentication, payments, trading, or Challenge rules, and it does not close open founder questions. Technology chosen while the brief still listed candidates is **PROPOSED** (see [TECH_STACK_DECISIONS.md](./TECH_STACK_DECISIONS.md)). Confirmed business rules in this folder were not rewritten.
>
> **Status of the business documents:** planning artefacts. Nothing in this folder marks the firm production-ready or approves an unresolved business rule. The documentation-only restriction below governed the phase that wrote these business documents. It is not a description of the current repository, which now contains the Module 01 foundation.

## Purpose

K2 Group is being developed as an international proprietary trading firm and, in the long term, a broader financial group. The brand philosophy, inspired by the K2 mountain, is ambition, discipline, precision, resilience, and the pursuit of exceptionally difficult goals. The objective is an institutional-quality trading firm platform where **accuracy, financial integrity, security, and auditability take priority over superficial speed**.

This documentation set organises the founder's confirmed decisions, separates them from architectural recommendations, and makes every unresolved item explicit so that no business rule is silently invented during implementation.

## Single Source of Truth

The only business source for this documentation set is the founder brief: `K2-MASTER-PLAN.txt` ("K2 Group — Project Foundation & Master Planning"). Where the brief is silent, these documents say so and record the gap in [OPEN_QUESTIONS.md](./OPEN_QUESTIONS.md). They do not fill gaps with assumptions presented as fact.

## Status Tag Convention

Every business rule in this documentation set carries exactly one of the following tags:

| Tag | Meaning |
|---|---|
| **CONFIRMED** | Explicitly stated by the founder in the master brief. May be implemented as written once technical details are specified. |
| **PROPOSED** | A recommendation from the architecture/planning team. **Not approved.** Requires founder sign-off before it becomes a rule. |
| **UNRESOLVED** | The brief identifies the topic but does not decide it, or the brief is ambiguous or internally contradictory. Must not be implemented until decided. |
| **REQUIRES LEGAL REVIEW** | Cannot be finalised without qualified legal, regulatory, tax, or licensing advice in the relevant jurisdictions. |

A rule may be CONFIRMED as a business intent and still carry a REQUIRES LEGAL REVIEW flag on its operation (for example, company-funded payouts of simulated profits). Where that occurs, both tags are shown.

All architecture, database, and API content is **PROPOSED** in its entirety.

## Document Index

| # | Document | Scope |
|---|---|---|
| 1 | [BUSINESS_PLAN.md](./BUSINESS_PLAN.md) | Company vision, business model, market policy, and the canonical **Business Rules Register** (Challenge prices, two-stage rules, subscription, commission, Funded Simulation, payouts, Real Accounts, profit distribution, future modules). |
| 2 | [PRODUCT_REQUIREMENTS.md](./PRODUCT_REQUIREMENTS.md) | User roles, user journeys, functional and non-functional requirements for traders, administrators, and risk staff. |
| 3 | [TECHNICAL_ARCHITECTURE.md](./TECHNICAL_ARCHITECTURE.md) | PROPOSED system architecture: responsive web + PWA, dark institutional UI, service decomposition, market data, simulation execution, hosting candidates (Railway vs Vercel), scale from ~1,000 to ~10,000 registered traders. |
| 4 | [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) | PROPOSED logical data model described in tables and prose (no DDL, no migrations). Immutable ledger design. |
| 5 | [API_SPECIFICATION.md](./API_SPECIFICATION.md) | PROPOSED API surface described as resource and endpoint tables (no implementation). REST + WebSocket conventions, idempotency, audit. |
| 6 | [SECURITY_REQUIREMENTS.md](./SECURITY_REQUIREMENTS.md) | Authentication, RBAC, admin controls, secrets, payment integrity, audit logs, anti-fraud, backups, monitoring, incident management. |
| 7 | [MODULE_ROADMAP.md](./MODULE_ROADMAP.md) | All twenty modules from the brief, their dependencies, MVP vs future classification, and a proposed phasing. |
| 8 | [DECISIONS_LOG.md](./DECISIONS_LOG.md) | Chronological register of confirmed founder decisions and, separately, pending recommendations awaiting decision. |
| 9 | [OPEN_QUESTIONS.md](./OPEN_QUESTIONS.md) | Unresolved items, contradictions, and critical risks with impact analysis and proposed (non-binding) resolutions. |
| 10 | [MVP_SCOPE.md](./MVP_SCOPE.md) | Proposed MVP boundary. Investor Copy Trading and Global Competition are explicitly **out of MVP**. Launch gates. |
| 11 | [PROJECT_STRUCTURE.md](./PROJECT_STRUCTURE.md) | Module 01 repository layout. Technical. |
| 12 | [TECH_STACK_DECISIONS.md](./TECH_STACK_DECISIONS.md) | Module 01 stack evaluation. PROPOSED where the brief left the choice open. |
| 13 | [DEVELOPMENT_SETUP.md](./DEVELOPMENT_SETUP.md) | How to run the foundation locally. |
| 14 | [ENVIRONMENT_CONFIGURATION.md](./ENVIRONMENT_CONFIGURATION.md) | Development, staging, and production configuration. |
| 15 | [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) | Staging preparation for Vercel and Railway. Accounts are not created. |
| 16 | [TESTING_GUIDE.md](./TESTING_GUIDE.md) | Unit, integration, and end-to-end commands. |
| 17 | [ARCHITECTURE_DECISIONS.md](./ARCHITECTURE_DECISIONS.md) | Module 01 architecture decisions and the security baseline. |

## Reading Order

1. **Founder / management:** BUSINESS_PLAN → OPEN_QUESTIONS → DECISIONS_LOG → MVP_SCOPE.
2. **Engineering leads:** PRODUCT_REQUIREMENTS → TECHNICAL_ARCHITECTURE → DATABASE_SCHEMA → API_SPECIFICATION → SECURITY_REQUIREMENTS → MODULE_ROADMAP.
3. **Legal / compliance advisers:** BUSINESS_PLAN (items tagged REQUIRES LEGAL REVIEW) → OPEN_QUESTIONS (regulatory section) → SECURITY_REQUIREMENTS.

## Identifier Conventions

| Prefix | Used for | Defined in |
|---|---|---|
| `BR-xxx` | Business rule | BUSINESS_PLAN.md |
| `FR-xxx` / `NFR-xxx` | Functional / non-functional requirement | PRODUCT_REQUIREMENTS.md |
| `SEC-xxx` | Security requirement | SECURITY_REQUIREMENTS.md |
| `M-xx` | Module | MODULE_ROADMAP.md |
| `D-xxx` / `P-xxx` | Confirmed decision / pending proposal | DECISIONS_LOG.md |
| `OQ-xxx` / `RISK-xxx` | Open question / critical risk | OPEN_QUESTIONS.md |

## Phase Restrictions (from the founder brief)

These lines record the documentation phase. Module 01, a later specification, authorized the foundation code. They still forbid inventing business rules and committing credentials.

- **CONFIRMED:** Do not write application code in this phase.
- **CONFIRMED:** Do not create frontend components, backend services, database migrations, APIs, or trading engines.
- **CONFIRMED:** Do not modify or delete existing repository files.
- **CONFIRMED:** Do not invent business rules or silently make decisions on behalf of the founder.
- **CONFIRMED:** Never store API keys, passwords, or private credentials in GitHub source code.

## Next Step

The recommended next phase is a **decision workshop** with the founder to close the blocking items listed in OPEN_QUESTIONS.md (drawdown formulas, Funded Simulation payout split, commission across markets, US equities data licensing, broker selection, hosting choice, and the regulatory opinion). Only after those are closed should technical specification and implementation of the MVP begin.
