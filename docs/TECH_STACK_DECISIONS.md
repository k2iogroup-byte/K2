# Technology stack decisions

Module 01 required an evaluation, not a popularity contest. Each choice below records:

1. Selected technology
2. Reason
3. Alternatives considered
4. Operational and scaling implications
5. Estimated cost

**Status labels**

| Label                 | Meaning                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Required by Module 01 | The module specification names this technology or constraint                                                                      |
| PROPOSED              | An engineering selection. The founder brief left the choice open (OQ-070, OQ-071). Implementing it does not close those questions |

Confirmed product constraints that this stack must keep supporting, and that this module does not implement: responsive web and PWA readiness, no native or Electron app, dark institutional UI, real market data later, simulated trading only, about 1,000 registered traders growing toward 10,000, not all of them active at once.

## Frontend — Next.js, React, TypeScript

1. **Selected:** Next.js 16, React 19, TypeScript.
2. **Reason:** The brief names React as the only frontend candidate and requires a responsive web app with PWA readiness. Next.js is the React framework already named in `TECHNICAL_ARCHITECTURE.md`. It gives file-based routing, a production build, and a straightforward Vercel deploy. The Module 01 shell is a server-rendered page plus a client health panel. PWA readiness is a manifest, a theme color, and a service worker that caches only same-origin shell assets. It does not cache API responses.
3. **Alternatives:** Vite plus React (less to operate, weaker fit for a later public site and for Vercel). Vue and Svelte (not named by the founder; a second UI ecosystem). A backend-rendered template with no SPA (poor fit for the later trading terminal).
4. **Operations and scale:** The frontend is stateless. At 1,000–10,000 registered traders the shell is CDN-cached HTML and assets. Live market fan-out will not run inside this Next.js process; that stays on the API WebSocket when a later module needs it. System fonts are used so the build does not call a font host.
5. **Cost:** No account was created. Vercel Hobby is not the right plan for a commercial firm. A Pro seat is the usual commercial starting point (confirm the current price on Vercel’s pricing page; it has historically been about $20 per developer seat per month, plus usage). This shell’s bandwidth is small. The cost that matters later is market-data licensing, which is outside Module 01.

**Status:** PROPOSED (OQ-070 remains open).

## Backend — Node.js, TypeScript, Fastify

1. **Selected:** Node.js 22, TypeScript in strict mode, Fastify 5, as one modular monolith.
2. **Reason:** The same language as the frontend lets `packages/shared` hold the health and error contracts. Fastify provides a schema-friendly HTTP server, works with Helmet and CORS as plugins, and has a WebSocket plugin. It does not impose a decorator framework. A second language for a trading engine was considered in the architecture notes and rejected for Module 01: there is no load evidence, and two runtimes would double the operational surface (this matches the audit concern about a polyglot backend).
3. **Alternatives:** Express (validation and logging are extra assemblies). NestJS (more structure than this module uses). A JVM or Go engine process (revisit after a measured hot path exists).
4. **Operations and scale:** One stateless API process plus PostgreSQL is enough for the foundation and for the early concurrent-session range in the architecture notes (on the order of hundreds of sessions, not tens of thousands of market-data sockets). WebSocket support is a single `/ws` route that answers `ping`. It is not a fan-out bus. Horizontal scaling later is a second API replica behind the host’s proxy; sticky sessions are not required while the only socket behavior is ping/pong. Background work is a separate Node process (`worker.ts`), not a new repository.
5. **Cost:** The runtime is free. Hosting cost is under Railway below.

**Status:** TypeScript and a separate backend are required by Module 01. Fastify specifically is PROPOSED.

## Database — PostgreSQL 16

1. **Selected:** PostgreSQL 16, with SQL migrations stored in git.
2. **Reason:** Module 01 requires PostgreSQL, versioned migrations, rollback, connection management, and a health check. PostgreSQL is also the store proposed for an append-only ledger later, because it has transactions and exact `numeric` types. Module 01 does not create that ledger.
3. **Alternatives:** SQLite (weaker concurrent-write and hosting story for a later multi-process API). MySQL (capable, but the existing architecture proposal and the money-type requirements point at PostgreSQL). A hosted database other than PostgreSQL (rejected; the module specifies PostgreSQL).
4. **Operations and scale:** Local development uses one server and two databases, `k2_dev` and `k2_test`. The API uses a `pg` pool with a 5 second statement timeout. Migrations run in a transaction. A changed checksum of an applied file is rejected. The API does not migrate on boot, so a rolling restart cannot race DDL. At the 1,000-trader target, one primary instance is the right starting point. Read replicas and point-in-time recovery are later operational work, not objects created here.
5. **Cost:** Local PostgreSQL is free. A small Railway Postgres volume for staging is usage-priced (CPU, RAM, and disk). For a foundation database with one marker row, expect a small monthly amount, commonly in the range of a few dollars to the low tens of dollars. Confirm Railway’s current database price before creating it. Production sizing is not part of this module.

**Status:** Required by Module 01.

## Cache and messaging — no Redis

1. **Selected:** No Redis in Module 01.
2. **Reason:** Nothing in this module shares sessions, rate-limit counters, or fan-out across processes. Adding Redis now would be an unused service to patch, back up, and pay for. The architecture notes already prefer a PostgreSQL outbox over a streaming platform until load requires one.
3. **Alternatives:** Redis for sessions and pub/sub (justified when authentication or market-data fan-out exists). PostgreSQL `LISTEN/NOTIFY` (also premature).
4. **Operations and scale:** One fewer network dependency. A single API instance is the deployment. When a second instance must share ephemeral state, add Redis or the outbox then, in that module, with a written reason.
5. **Cost:** $0 now. A small Redis instance later is another few dollars per month on a typical usage-priced host.

**Status:** PROPOSED deferral. Required only in the sense that Module 01 says to use Redis if justified. It is not justified yet.

## API — HTTP and WebSocket

1. **Selected:** REST-style HTTP for `/health`, and a WebSocket at `/ws` that accepts `{ "type": "ping" }` and returns `{ "type": "pong", "timestamp" }`.
2. **Reason:** The module requires both HTTP and WebSocket infrastructure, and it forbids trading behavior. Ping/pong proves the upgrade path, origin check, and message validation without a market protocol.
3. **Alternatives:** GraphQL (no client need). Server-Sent Events only (does not meet the WebSocket requirement). A socket that subscribes to symbols (that would be market-data scope).
4. **Operations and scale:** HTTP is stateless. The socket holds one connection per client and no server-side subscription table. Origin is checked against `CORS_ORIGINS`. Missing `Origin` is allowed so non-browser probes and tests can connect. Browsers send `Origin`.
5. **Cost:** Included in the API process. No extra vendor.

**Status:** HTTP and WebSocket support are required by Module 01. The ping protocol is the minimum implementation.

## Testing — Node test runner via Vitest, plus Playwright

1. **Selected:** Vitest for unit and integration tests, v8 coverage, Playwright Chromium for end-to-end tests.
2. **Reason:** One runner can load the TypeScript API, the shared package, and the web helper. Integration tests talk to a real PostgreSQL, which a mock would not prove. Playwright drives the built frontend and the built API on desktop and mobile viewports.
3. **Alternatives:** Node’s built-in test runner (less convenient for the React package and coverage). Jest (heavier ESM configuration). Cypress (a second browser stack; Playwright is enough).
4. **Operations and scale:** Unit tests do not need a database. Integration tests refuse to run unless the database name ends with `_test`. End-to-end tests are local in Module 01; CI runs unit tests and integration tests. See [TESTING_GUIDE.md](./TESTING_GUIDE.md).
5. **Cost:** Tooling is free. CI minutes are the only cost, and this workflow is a few minutes per pull request.

**Status:** Unit, integration, and end-to-end infrastructure are required by Module 01. Vitest and Playwright specifically are PROPOSED.

## CI — GitHub Actions

1. **Selected:** GitHub Actions on pull requests and on pushes to `module-01-project-foundation`.
2. **Reason:** GitHub is the confirmed source host. The workflow installs dependencies, typechecks, lints, runs unit tests with coverage, builds, and runs `npm audit` at high severity. A second job runs integration tests against PostgreSQL 16. There is no deploy job.
3. **Alternatives:** A hosted CI product outside GitHub (extra account, no benefit at this size).
4. **Operations and scale:** Required checks block merge only after the repository owner marks the jobs as required. This module cannot change branch protection. The workflow requests `contents: read` only.
5. **Cost:** Included GitHub minutes. Negligible for this suite. Confirm the private-repository minute allowance on the current GitHub plan.

**Status:** Required by Module 01.

## Deployment targets — Vercel and Railway

1. **Selected for preparation:** Vercel for the frontend, Railway for the API and PostgreSQL. Nothing was created.
2. **Reason:** Both are the candidates named in the brief. Vercel fits a Next.js frontend. Railway fits a long-running Node process, a pre-deploy migration command, a `/health` check, and a private Postgres URL. A hybrid is the existing architecture proposal. Module 01 prepares it and does not treat it as a founder approval.
3. **Alternatives:** One container platform for both (simpler vendor count; weaker CDN for the frontend). A major cloud provider (more compliance controls later, more setup now). Serverless for the API (poor fit for a process that will hold WebSockets).
4. **Operations and scale:** Staging is one frontend project, one API service, and one Postgres plugin, in a Railway environment that must be named `staging`. The infrastructure file refuses any other environment name, including `production`. Migrations are a pre-deploy command. The API does not migrate itself. See [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md).
5. **Cost:** $0 was spent. Combined staging cost for this shell is the Vercel commercial plan plus a small Railway API and database. Budget a low tens of dollars per month until market data and real traffic exist, and confirm both vendors’ current prices. Production is out of scope and must not be created from this file.

**Status:** PROPOSED (OQ-071 remains open). Preparation is required by Module 01. Creating the accounts is pending owner credentials.

## Validation library — Zod

1. **Selected:** Zod 4 for HTTP, WebSocket, and shared response contracts. Environment variables use a dedicated validator.
2. **Reason:** The shared package needs one schema that both processes execute. Environment errors must never echo a password. Zod’s default messages can include the received value, so `loadConfig` builds its own messages and never interpolates the raw variable.
3. **Alternatives:** Hand-written checks for HTTP as well (more drift between web and API). A second schema language.
4. **Operations:** Zod is a library dependency of `@k2/shared` and the API. It is not a service.
5. **Cost:** $0.

**Status:** PROPOSED library. Validation at startup and at the HTTP boundary is required by Module 01.

## Logging — Pino JSON

1. **Selected:** Pino JSON logs, with redaction paths and a text redactor for connection strings and bearer tokens.
2. **Reason:** Fastify already logs with Pino. JSON is what a later collector can index. A pretty printer is not a dependency.
3. **Alternatives:** `console.log` (unstructured, easy to leak). A hosted log vendor in this module (no account, and nothing to ship yet).
4. **Operations:** Request logs contain method, path without query string, request id, and status. They do not contain headers, cookies, or the database URL.
5. **Cost:** $0 until a log vendor is chosen.

**Status:** Structured logging without sensitive data is required by Module 01. Pino specifically is PROPOSED.
