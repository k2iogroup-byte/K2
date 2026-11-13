# Architecture decisions

These decisions implement Module 01. They do not approve business rules. Items the founder brief left open stay **PROPOSED**. Items the module specification required are marked **Required**.

## ADR-001 — Modular monolith, two processes

**Status:** Required (separate frontend and backend, modular monolith, no premature microservices).

The web app and the API are separate Node packages in one repository. Domain behavior for this module is the health module. Database access is behind `DatabaseProbe` and the migration runner. The browser does not open PostgreSQL.

A third process entry, `worker.ts`, can run beside the API using the same code and the same configuration validator. No job is registered. The Railway definition does not start it.

## ADR-002 — Strict TypeScript, one language

**Status:** TypeScript strict mode is required. One language is PROPOSED.

`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, and `verbatimModuleSyntax` are on. ESLint uses type-checked rules and forbids `any` unless a boundary is narrowed without carrying `any` forward (the WebSocket `headers` value is read through a `unknown` guard). Prettier is the formatter. Imports are ordered.

A JVM or Go engine is not introduced. Revisit that only after a measured hot path exists.

## ADR-003 — PostgreSQL migrations with checksums and rollback

**Status:** Required.

Migrations are SQL in git. `0001_foundation_schema_info` creates one infrastructure row. It is not a business table. The logical model in `DATABASE_SCHEMA.md` is not implemented.

The runner creates `schema_migrations` with version, name, checksum, and timestamp. Up and down are transactional. Rollback removes the latest version only. An edited up file fails with a checksum error and does not run.

The server never migrates on boot. Staging runs `npm run db:migrate -w @k2/api` as a Railway pre-deploy command. A non-zero exit stops the deploy.

## ADR-004 — No speculative tables and no Redis

**Status:** Required (no speculative schema). Redis deferral is PROPOSED and justified in [TECH_STACK_DECISIONS.md](./TECH_STACK_DECISIONS.md).

There are no user, account, order, ledger, payment, copy-trading, or competition tables.

## ADR-005 — Configuration fails closed

**Status:** Required.

`loadConfig` runs before `listen`. Error text is chosen by the application and does not include the raw value. Placeholder passwords, wildcard CORS, localhost in staging or production, and disabled TLS on a public database host are rejected. Details are in [ENVIRONMENT_CONFIGURATION.md](./ENVIRONMENT_CONFIGURATION.md).

## ADR-006 — Security baseline, and what it is not

**Status:** The baseline below is required by Module 01. It is not a claim that the platform is secure.

Implemented:

| Control            | Where                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Security headers   | `@fastify/helmet` on the API. `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `Permissions-Policy` on the web app |
| CORS               | Explicit origin list. `*` rejected. Methods are GET and OPTIONS because Module 01 has no state-changing HTTP route                    |
| Request validation | Zod via `parseWithSchema`. Unknown query keys on `/health` fail. WebSocket messages must be `{ "type": "ping" }`                      |
| Body limit         | 16 KB. Larger requests get HTTP 413 and a fixed message                                                                               |
| Central errors     | `installErrorHandling`. 500 responses omit stacks and SQL                                                                             |
| Structured logs    | Pino JSON. Query strings stripped. Connection strings and bearer tokens redacted                                                      |
| Secrets            | `.env` gitignored. Example files have placeholders. CI secret check. Hosting stores real secrets                                      |
| Dependency audit   | `npm audit --audit-level=high` in CI                                                                                                  |
| Request timeout    | 15 seconds on the HTTP server                                                                                                         |
| WebSocket origin   | Same allowlist as CORS                                                                                                                |

Not implemented, and required later by `SECURITY_REQUIREMENTS.md` (those controls stay PROPOSED until their modules):

- Authentication, sessions, MFA, password storage (M-02)
- RBAC and admin separation of duties
- Rate limiting and bot protection (the brief lists rate limiting; this module’s baseline list does not include a limiter, and there is no credentialed route to limit yet)
- Payment integrity, ledger immutability, and audit chains
- A strict Content-Security-Policy on the HTML app. Next.js emits inline scripts. A nonce policy belongs with the real UI, not a broken header that blocks the shell. The API response CSP is strict because the API does not serve HTML
- Platform secret scanning and push protection (a GitHub setting the owner turns on; the CI script is a narrower file scan)
- Action SHA pinning. The workflow uses `actions/checkout@v4` and `actions/setup-node@v4` tags. Pinning to full SHAs is a follow-up
- Backups, restore drills, intrusion detection, and a penetration test
- The moderate `minimatch` advisory in ESLint’s dependency tree (GHSA-g3hv-75wg-m249). `npm audit --audit-level=high` passes. Forcing the audit fix downgrades ESLint across a major version. Track the advisory and upgrade when ESLint or typescript-eslint publishes a fixed tree. It is a development-tool input, not a production request parser

## ADR-007 — Health is infrastructure, not a business API

**Status:** Required (health endpoint). The business API in `API_SPECIFICATION.md` is unchanged and unimplemented.

`GET /health` returns:

```json
{
  "status": "ok",
  "service": "k2-api",
  "version": "0.1.0",
  "environment": "development",
  "checks": {
    "database": { "status": "up", "latencyMs": 1, "schemaVersion": "0001" }
  },
  "timestamp": "2026-11-13T00:00:00.000Z"
}
```

`status` is `ok` and HTTP is 200 only when the database is reachable and `schemaVersion` is present. Otherwise HTTP is 503 and `status` is `degraded`. Database `up` with a null schema means the server can connect and migrations have not been applied.

## ADR-008 — PWA readiness without offline trading

**Status:** PWA readiness is a confirmed product constraint. The service worker is PROPOSED as the minimum that satisfies it.

`manifest.webmanifest`, `icon.svg`, `theme-color`, and a service worker are shipped. The worker caches same-origin GET responses for the shell and never calls the API. It is registered only in production. SVG icons have uneven install support; a PNG set belongs with the visual design, not this module. There is no offline order ticket.

## ADR-009 — Staging targets, not a production platform

**Status:** The platform split is CONFIRMED (D-077). Staging is still not provisioned.

Vercel serves the frontend. Railway serves the API and Postgres. The service map, cookie rules, and environment matrix are in [DEPLOYMENT_ARCHITECTURE.md](./DEPLOYMENT_ARCHITECTURE.md). The staging sequence remains [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md). No hosted resource exists yet. `.railway/railway.ts` still refuses an environment that is not named `staging`.

## ADR-010 — Business documents stay the business source

**Status:** Required by the module instructions (do not rewrite confirmed business rules).

`BUSINESS_PLAN.md`, `DECISIONS_LOG.md`, `OPEN_QUESTIONS.md`, `PRODUCT_REQUIREMENTS.md`, `MVP_SCOPE.md`, and the business sections of the other planning documents were not rewritten. Technology notes were added only where a reader would otherwise think the documentation-only phase still forbids a foundation, or that the logical database had been created. Those notes are labeled.

OQ-070 (React) remains open. OQ-071 (Railway and Vercel) is closed by D-077. This repository is the engineering selection the Module 01 specification told the team to make so later modules have one codebase.

## ADR-011 — Server-side sessions for Module 02

**Status:** Required by the Module 02 specification. The earlier `/v1` refresh-token sketch stays PROPOSED and was not built.

Authentication is an opaque session row in PostgreSQL. The cookie holds the token. The database holds its SHA-256 hash. There is no access token in browser storage and no refresh endpoint.

The browser talks to `/k2-api` on the Next.js origin. That route proxies to the API, so the session cookie is first-party and `SameSite=Lax`. `Secure` is set outside development. CSRF uses `x-k2-request` plus a session-bound `k2_csrf` cookie. CORS remains an explicit origin list and now allows the authentication methods.

Authentication rate limits are PostgreSQL rows keyed by the normalized client address from `request.ip`. `TRUST_PROXY` defaults to off, accepts a hop count of 1 to 5 or a CIDR list, and rejects `true`. The staging Railway file sets `1`. Railway's actual proxy chain has not been observed from this repository. Expired rows are deleted in bounded batches. See [DEPLOYMENT_ARCHITECTURE.md](./DEPLOYMENT_ARCHITECTURE.md). The in-memory limiter remains a test double. Redis was not added.

Argon2id parameters, session lifetimes, and the permission grants are engineering defaults recorded in [MODULE_02_AUTHENTICATION.md](./MODULE_02_AUTHENTICATION.md). They are not new founder business rules.

Staff SSO is not implemented. MFA for staff is TOTP, encrypted at rest, and required before `/staff/*` routes. Traders are not enrolled at registration. `sessions.mfa_verified_at` is the marker a later payout module can require.

## ADR-004 note after Module 02

ADR-004 still forbids speculative trading, ledger, and competition tables, and it still defers Redis. Module 02 added only the identity tables in migration `0002_identity_access`.

## ADR-012 — Challenge catalogue without a ledger

**Status:** Required by the Module 03 specification. Open business questions were not closed.

Module 03 stores confirmed challenge prices and rule numbers as versioned rows. Accounts keep the price version and rule-set version they were provisioned with. Pass, fail, expiry, and activation are rejected because OQ-001 through OQ-005 and the activation condition are unresolved. Purchase provisioning accepts evidence only from the M-08 contract and does not post a journal. Redis was not added. The implemented contract is [MODULE_03_CHALLENGE_ACCOUNTS.md](./MODULE_03_CHALLENGE_ACCOUNTS.md).

## ADR-013 — In-process market data, fixture only

**Status:** Required by the Module 04 specification. OQ-073 and OQ-074 stay open.

Market data runs inside the API process because that process already holds the WebSocket connections. Redis and Kafka were not added. The only provider is a labeled test fixture. A vendor adapter that could set `liveMarketData` is not registered. The contract is [MODULE_04_MARKET_DATA.md](./MODULE_04_MARKET_DATA.md).
