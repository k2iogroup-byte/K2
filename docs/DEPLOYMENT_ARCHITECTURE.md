# K2 Group — Deployment architecture

> **Status:** The platform split below is a **CONFIRMED** founder decision (2026-11-13, [DECISIONS_LOG.md](./DECISIONS_LOG.md) D-077). Domain, DNS, paid plans, database region, and backup retention are **PROPOSED** and are not approved. No Vercel project, Railway project, database, domain, or deployment was created or modified for this document. GitHub Actions has no deploy job. `.railway/railway.ts` is not applied by CI.

This file is the hosting map for the repository as it exists. It does not rewrite the modules. Where the current code cannot meet a requirement, the gap is recorded with a recommended fix and a status.

## 1. What runs where

The frontend and the backend deploy independently. A frontend release does not restart the API, and an API release does not rebuild the website.

| Service    | Code                               | Platform                           | Process                                                                                                          | Public?   |
| ---------- | ---------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------- |
| Web        | `apps/web`                         | Vercel                             | Next.js (Node.js). Public site, trader terminal, dashboard, admin pages, static assets, CDN, preview deployments | Yes       |
| API        | `apps/api` (`src/index.ts`)        | Railway service `api`              | Fastify HTTP and WebSocket. Authentication, accounts, and the in-process market-data engine                      | Yes       |
| Worker     | `apps/api` (`src/worker.ts`)       | Railway service, **not created**   | Same configuration validator. `REGISTERED_JOBS` is empty                                                         | No        |
| PostgreSQL | Railway Postgres plugin `postgres` | Railway, **proposed, not created** | Private database for the API and, later, the worker                                                              | No        |
| CI         | `.github/workflows/ci.yml`         | GitHub Actions                     | Install, typecheck, lint, unit tests, build, audit, integration tests, Playwright                                | No deploy |

Trading, risk, payments, and the ledger are not implemented. When they exist, long-running engines belong on Railway as their own services. They are not added here. See [requirement 7](#54-requirement-7-no-forced-monolith).

Vercel does not host the API, the worker, PostgreSQL, or the WebSocket server. Railway does not host the website.

## 2. How the browser reaches the API

```text
Browser
  |  HTTPS same-origin  /k2-api/...     cookies stay on the web host
  v
Vercel (apps/web)  route apps/web/app/k2-api/[...path]/route.ts
  |  server-side fetch  API_PROXY_DESTINATION
  v
Railway API  https://api.<domain>   (public; Vercel cannot join Railway private DNS)

Browser health panel
  |  HTTPS cross-origin  NEXT_PUBLIC_API_BASE_URL/health
  v
Railway API  (CORS allowlist must contain the web origin)

Browser WebSocket
  |  WSS directly to Railway. Not through Vercel.
  v
Railway API  wss://api.<domain>/ws
             wss://api.<domain>/ws/market-data
```

### 2.1 HTTP API and `/k2-api`

Authentication pages call `/k2-api` on the web origin (`apps/web/lib/auth-client.ts`). The Next.js route forwards `cookie`, `x-k2-request`, `x-csrf-token`, and `x-request-id` to `API_PROXY_DESTINATION` (default `http://127.0.0.1:4000`) and copies `set-cookie` back. The browser stores those cookies for the web host. That is why `SameSite=Lax` works on local HTTP.

`API_PROXY_DESTINATION` is read on the server. It is not a `NEXT_PUBLIC_` variable and it must not contain a password. On Vercel it is the Railway **public** origin, because the two platforms do not share a private network.

Do not replace this route with a Vercel rewrite that sends the browser to Railway. The browser would then be on another site, and the host-only session cookie would not stick. There is no rewrite in `apps/web/vercel.json`.

The service worker (`apps/web/public/sw.js`) ignores `/k2-api` and every other origin. It does not sit on the API or WebSocket path. It is registered only when `NODE_ENV` is `production`.

### 2.2 Health check from the browser

`NEXT_PUBLIC_API_BASE_URL` is inlined at **build** time and is public. The health panel fetches `{origin}/health` from the browser, so the web origin must be in `CORS_ORIGINS`. Changing the value requires a new web build.

`GET /health` on the API returns 200 only when PostgreSQL answers and `foundation_schema_info` has a schema version. Otherwise it returns 503. The body has no connection string. Migration `0001` inserts schema version `0001` and later migrations do not change that cell, so a healthy body still says `0001` after migrations `0002` through `0005`. The applied set is `schema_migrations`. On Railway, `npm run db:status -w @k2/api` reads it. Railway's deploy check uses `/health` and does not prove which later migrations ran.

### 2.3 WebSocket

The browser must open `wss://api.<domain>/ws` and `wss://api.<domain>/ws/market-data` itself. The Next.js proxy implements `GET`, `POST`, `PATCH`, and `DELETE` only. It cannot carry a WebSocket upgrade, and Vercel must not be placed in front of the socket. No web client opens a socket yet. When one is added, its URL is the Railway origin, not the Vercel origin. A variable such as `NEXT_PUBLIC_WS_BASE_URL` is **not implemented** and is not read.

`/ws` answers a ping after an origin check. `/ws/market-data` also requires a `k2_session` cookie for a verified user with `market_data.read`. See [issue b](#5-known-issues).

## 3. DNS and domains

**PROPOSED. The registrable domain is a founder decision. No name is chosen here.**

`*.vercel.app` and `*.railway.app` are different sites. They cannot share the session cookie. Production and staging need one registrable domain owned by the firm, with the website and the API as sibling hosts:

| Hostname               | Target                                          | Use                      |
| ---------------------- | ----------------------------------------------- | ------------------------ |
| `app.<domain>`         | Vercel                                          | Production web           |
| `api.<domain>`         | Railway service `api`                           | Production HTTPS and WSS |
| `app.staging.<domain>` | Vercel staging (or a second Vercel environment) | Staging web              |
| `api.staging.<domain>` | Railway environment `staging`, service `api`    | Staging HTTPS and WSS    |

The apex and `www` are not configured. A redirect to `app.<domain>` is a reasonable later DNS rule, not part of this change. The worker and PostgreSQL have no public names. PostgreSQL stays on Railway private DNS (`*.railway.internal`).

TLS certificates come from the platforms after DNS is attached. Private keys are not committed.

Preview deployments stay on `*.vercel.app` until the founder attaches preview hostnames under `<domain>`. See [issue a](#51-session-cookie-and-same-site).

Railway's Free plan, after a trial ends, allows no custom domains (pricing page, 2026-11-13). A custom `api` hostname needs a paid Railway plan. The trial allows one custom domain and is not a durable home for the database. See [issue e](#45-plans-and-trial-limits).

## 4. Deploy settings that are already in the repo

These settings are files and commands. Applying them is an owner action. This change does not run it.

### 4.1 Vercel (web)

| Setting        | Value                                                                 |
| -------------- | --------------------------------------------------------------------- |
| Root Directory | `apps/web`                                                            |
| Framework      | Next.js (`apps/web/vercel.json`)                                      |
| Install        | `cd ../.. && npm ci`                                                  |
| Build          | `cd ../.. && npm run build -w @k2/shared && npm run build -w @k2/web` |
| Node.js        | `>=22.13.0` (`package.json` `engines`)                                |
| Output         | Next.js default. No `vercel.json` rewrites                            |

The root directory must be `apps/web`. A repository-root Vercel project would not see `vercel.json` and would not find the Next.js app at the root.

### 4.2 Railway (API and Postgres)

Config file: `.railway/railway.ts`. It throws unless the linked environment is named `staging`. Production is refused by that file. The Railway CLI evaluates it. Pushing to GitHub does not apply it. `railway.toml` and `railway.json` are not used.

The service root is the **repository root**. The build uses npm workspaces. Do not set the root to `apps/api`.

| Setting              | API service                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| Build                | `npm run build -w @k2/shared && npm run build -w @k2/api`                                             |
| Release / pre-deploy | `npm run db:migrate -w @k2/api` (120s). Non-zero stops the deploy. The previous release keeps serving |
| Start                | `npm run start -w @k2/api` (`node dist/index.js`)                                                     |
| Health check         | `GET /health`, timeout 120s                                                                           |
| Replicas             | `1`                                                                                                   |
| Restart              | on failure, up to 5 times                                                                             |
| Listen               | `HOST=0.0.0.0`. `PORT` is the port Railway injects. The app reads `PORT`                              |

The process does not migrate on boot. Only the API pre-deploy command migrates. The worker must not migrate.

`DATABASE_URL` is wired from the private Postgres variable. `DATABASE_SSL=disable` matches `*.railway.internal`. A public database proxy URL must use `no-verify` or `verify`.

Before the first apply, the owner sets these on the API service. The file uses `preserve()` so a later apply does not wipe them:

| Variable             | Owner value                                                                        |
| -------------------- | ---------------------------------------------------------------------------------- |
| `CORS_ORIGINS`       | Exact staging web origin, `https`, no path                                         |
| `WEB_ORIGIN`         | One of `CORS_ORIGINS`. Email links use it                                          |
| `MFA_ENCRYPTION_KEY` | 32-byte key, base64. Generate locally. Do not commit it                            |
| `EMAIL_DELIVERY`     | `unconfigured` until an SMTP vendor is chosen, then `smtp` plus the SMTP variables |

`TRUST_PROXY=1` and `MARKET_DATA_MODE=disconnected` are committed in the staging file. `disconnected` does not contact a market-data vendor.

### 4.3 Worker (defined, not created)

Create this Railway service only when `REGISTERED_JOBS` is no longer empty. An idle process still uses a service slot and credit.

| Setting       | Value                                                                           |
| ------------- | ------------------------------------------------------------------------------- |
| Root          | Repository root                                                                 |
| Build         | Same as the API                                                                 |
| Start         | `npm run start:worker -w @k2/api`                                               |
| Pre-deploy    | None                                                                            |
| Health check  | None. The worker does not listen, so an HTTP health check would fail the deploy |
| Domain        | None                                                                            |
| Database      | Same private `DATABASE_URL` as the API                                          |
| `TRUST_PROXY` | Irrelevant. The worker does not read client addresses                           |

## 5. Known issues

### 5.1 Session cookie and same-site

**Status: DOCUMENTED. BLOCKED BY FOUNDER DECISION (the domain). The cookie `Domain` attribute is not implemented.**

Current cookies (`apps/api/src/modules/auth/cookies.ts`):

| Cookie       | HttpOnly                                    | SameSite | Secure                                  | Path | Domain              |
| ------------ | ------------------------------------------- | -------- | --------------------------------------- | ---- | ------------------- |
| `k2_session` | yes                                         | `Lax`    | yes when `APP_ENV` is not `development` | `/`  | omitted (host-only) |
| `k2_mfa`     | yes                                         | `Lax`    | same                                    | `/`  | omitted             |
| `k2_csrf`    | no (the page copies it into `x-csrf-token`) | `Lax`    | same                                    | `/`  | omitted             |

No `Domain` means the browser stores the cookie for the host that returned `Set-Cookie`. Through `/k2-api`, that host is the web host. Local development and a single-host deployment keep working.

Separate `*.vercel.app` and `*.railway.app` hosts break that model:

- The proxy response can set a host-only cookie on the Vercel host. HTTP auth through `/k2-api` still works, because the proxy forwards the `Cookie` header.
- That cookie is not sent to `*.railway.app`. `SameSite=None` does not fix it. `None` only changes when a cookie is sent to the host it already belongs to.
- A response from `*.vercel.app` cannot set `Domain` to a Railway host. The `Domain` must be a suffix of the response host.
- `foo.vercel.app` and `bar.vercel.app` are the same site as each other. `*.railway.app` is a different site. Sibling platform hostnames are not a shared cookie domain.

Required production and staging shape, once the founder names `<domain>`:

| Attribute  | Value                                                                  |
| ---------- | ---------------------------------------------------------------------- |
| `Domain`   | `<domain>` (covers `app.<domain>` and `api.<domain>`)                  |
| `SameSite` | `Lax`. The two hosts are the same site, so `None` is the wrong setting |
| `Secure`   | `true` (already true outside development)                              |
| `Path`     | `/`                                                                    |
| Names      | unchanged                                                              |

The web host can set `Domain=<domain>` only when the browser is on `app.<domain>` or another host under `<domain>`. Recommended follow-up, after the domain is chosen: an env value such as `COOKIE_DOMAIN`, unset in development, set to the registrable domain in staging and production, and rejected when it is not a suffix of `WEB_ORIGIN`. That code is not added now, because a wrong domain would break sign-in and the domain is not known.

Preview implications:

- A Vercel preview URL is a `*.vercel.app` host. It cannot set `Domain=<domain>`.
- HTTP sign-in on a preview still works through `/k2-api` if `API_PROXY_DESTINATION` points at the **staging** API. Cookies stay host-only on that preview host.
- Authenticated WebSocket from that preview to Railway will not receive the cookie.
- Do not point a preview at the production API or the production database.
- Do not put the session token in `localStorage` or in the WebSocket query string to paper over the preview host. The query string would land in logs.
- Authenticated sockets on preview wait until preview hostnames exist under `<domain>`, or until a later task adds a separate socket credential. Neither is done here.

### 5.2 WebSocket cannot go through Vercel

**Status: DOCUMENTED. The direct Railway connection is a requirement. Handshake code was not changed.**

The browser connects to Railway:

- `wss://api.<domain>/ws`
- `wss://api.<domain>/ws/market-data`

Outside development those URLs are `wss` because Railway terminates TLS. `CORS_ORIGINS` must list the exact web origin (`https://app.<domain>`), never `*`. The same list is the WebSocket origin allowlist (`isAllowedOrigin` in `apps/api/src/infrastructure/http/origin.ts`). A mismatch closes the socket with `1008`.

Cookie authentication:

- `/ws/market-data` reads `k2_session` from the handshake cookie. There is no `Authorization` header and no token in the URL.
- The cookie is sent on that handshake only when the page and the API are the same site and the cookie's host or `Domain` covers `api.<domain>`. That depends on [issue a](#51-session-cookie-and-same-site).
- The socket then requires a verified email and `market_data.read`. Failure closes with `1008`.

CSRF and origin:

- HTTP writes require `x-k2-request: 1` and, when a session exists, `x-csrf-token` matching `k2_csrf`. Those headers are not checked on the WebSocket upgrade.
- `SameSite=Lax` withholds the cookie from a page on another site. A cross-site page cannot complete a cookie-authenticated handshake.
- The origin allowlist is the second control. `CORS_ORIGINS` is that list.
- Gap: a missing or empty `Origin` is allowed (`isAllowedOrigin` returns true). Browsers send `Origin` on a WebSocket handshake. A non-browser client can omit it and still present a cookie. Recommended fix, not done: when `APP_ENV` is `staging` or `production`, close `/ws` and `/ws/market-data` if `Origin` is missing. The current unit and integration suites connect from Node without an `Origin` header, so this change would need those tests updated. It was left as a follow-up rather than a silent handshake change.

`/ws` does not accept a session. It is a ping route. It still uses the origin allowlist, including the missing-Origin gap above.

### 5.3 `trustProxy` behind Railway

**Status: FIXED in code and tests. Not deployed. The staging file sets `TRUST_PROXY=1`. Confirm the recorded client address on the first staging login.**

`request.ip` is the key prefix for authentication rate limits (`login-ip:`, `register:`, and the other keys in `auth-service.ts`). Those buckets are rows in PostgreSQL (`PostgresRateLimiter`), shared by every API process. With `trustProxy: false`, the address is the TCP peer. Behind Railway that peer is the platform proxy, so every client shares one bucket.

`TRUST_PROXY` is now part of the configuration validator:

| Value                                                                 | Behavior                                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| unset, empty, `false`, or `0`                                         | Off. `X-Forwarded-For` is ignored. Default                                          |
| `1` through `5`                                                       | Trust that many proxies in front of the process                                     |
| Comma-separated IPs or CIDRs                                          | Trust only a peer in that list, then take the first address that is not in the list |
| `true`, `yes`, `on`, `all`, `*`, a hop count above 5, or a `/0` range | Rejected at startup. The process does not listen                                    |

`true` is rejected because it would take a client-supplied address from any peer. Fastify 5.12 also treats a **numeric** `trustProxy` as "trust nobody" and ignores `X-Forwarded-For`. The hop count is therefore a trust function, `(address, hop) => hop < n`, not the number passed through to Fastify. A future edit must not "simplify" it back to a number or to `true`.

A hop count does not check the peer's address. A client that can connect **directly** to the process, bypassing the proxy, can supply the next address. Tests lock that in. Railway's public traffic enters through the edge proxy, so `1` matches one proxy and ignores an address the client prepended. Prefer a CIDR list when the proxy ranges are known. They are not published in this repository, and none are invented here. Do not expose the container port except through that proxy. Private-network callers inside the Railway project can connect directly; do not treat their `X-Forwarded-For` as a client address while the setting is a hop count.

First staging check, after an owner deploys: sign in and read the IP on the authentication audit row. It should be the client address, not a Railway proxy address. If it is a private proxy address, the hop count does not match the real chain. Stop and set a CIDR, or the correct hop count, before relying on rate limits.

`numReplicas` stays `1` because the market-data engine is in-process, not because the rate limit is in-memory. The Postgres limiter is already shared. Extra API replicas would still duplicate the provider connection and split the fan-out.

### 5.4 Requirement 7, no forced monolith

**Status: DOCUMENTED. The engine was not split.**

Requirement 7 says Railway services should be separable, and that backend work must not be forced into one process.

Current state:

- `buildApp` creates `MarketDataEngine` inside the API process whenever a database pool exists.
- The provider callback, the fan-out, HTTP, and `/ws/market-data` share that process.
- The only provider modes are `disconnected` and `test-fixture`. `test-fixture` is refused outside development. No vendor socket is opened.
- `worker.ts` can start beside the API and uses the same validator. No job is registered. `.railway/railway.ts` does not define a worker. The worker was left out on purpose: it would cost money while idle.
- Redis and Kafka are not dependencies.
- The API replica count is 1.

That is one API process plus a separate worker entry that is not deployed. It does not yet meet requirement 7 as a target layout. Splitting it now would add a network hop and a bus the current load does not justify, and this task forbids that refactor.

Separation plan. Do not execute it until one of these is true:

1. The API must run more than one replica (deploy overlap, CPU, or a rolling restart that would drop every socket).
2. A load test shows ingest or fan-out delaying authentication or account requests in the same process.
3. A second consumer, such as risk or execution, needs the feed without running inside the API.
4. `REGISTERED_JOBS` gains a job. That starts the **worker** service only. It does not by itself move the market-data engine.

When a trigger is hit, the market-data service owns the single vendor connection and the engine. The API keeps the customer sockets and subscribes to that service. The bus is chosen then. Do not add Redis, Kafka, or another database in advance.

Until then: one Railway API service, one replica, `MARKET_DATA_MODE=disconnected` in staging and production.

### 5.5 Plans and trial limits

**Status: DOCUMENTED. BLOCKED BY FOUNDER DECISION (which plans to buy, and when). Nothing was purchased.**

Prices and limits below were read from the vendor pages on 2026-11-13. They change. Confirm them on the billing page before spending.

Vercel:

- The Hobby plan is personal and non-commercial. The [Terms of Service](https://vercel.com/legal/terms) Hobby section says the plan is only for personal or non-commercial use, and that Vercel may shut a Hobby project down. The [Fair Use Guidelines](https://vercel.com/docs/limits/fair-use-guidelines) say commercial use requires Pro or Enterprise. Commercial use includes a deployment made for financial gain, including when a paid employee or consultant writes the code, and includes advertising a product or taking payment.
- K2 Group is a commercial firm. Hobby is the wrong plan even for a private staging site built by paid staff. Use Pro or Enterprise before any Vercel project is created.
- The live Pro price was not copied into this file. Confirm it in the dashboard. Usage beyond the included amount is billed. The `/k2-api` route is a function invocation plus an outbound request on every proxied call. Market data must not be polled through that function. Sockets go to Railway.
- Set a spend alert before the first deploy.

Railway, from the [pricing page](https://railway.com/pricing) and the [trial document](https://docs.railway.com/pricing/free-trial):

| Plan  | Fee                         | Included usage                                  | Notable limits                                                                                                                                                                                                                               |
| ----- | --------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trial | $0                          | $5 once, 30 days, then the account becomes Free | Pricing table: 2 vCPU / 1 GB, 2 replicas, 7-day logs, 2 projects, 5 services, 500 MB volume, 1 custom domain. The trial document also caps the trial at 1 GB RAM and shared vCPU. Use the tighter number until the live plan page is checked |
| Free  | $0                          | $1 per month, not rolled over                   | 1 vCPU / 0.5 GB, 1 replica, 3-day logs, 1 project, 3 services, 500 MB volume, **0 custom domains**                                                                                                                                           |
| Hobby | $5 per month                | $5 usage                                        | Up to 48 vCPU / 48 GB, 6 replicas, 7-day logs, 5 GB volume, 2 custom domains                                                                                                                                                                 |
| Pro   | $20 per workspace per month | $20 usage                                       | Much higher caps, 30-day logs, 1 TB volume, 20 custom domains                                                                                                                                                                                |

The trial document says stateful volumes from a trial account are deleted 30 days after the credits expire. A trial database is disposable. Do not put anything that must be kept on a trial.

Egress is billed (the pricing page listed $0.05 per GB). There is no hard traffic cap; a workspace usage limit is what stops the bill, and hitting a hard limit stops the workloads. Set that limit before the first deploy.

Volume backups and point-in-time recovery are described in Railway's backup documents. Railway staff replies on Central Station say the Hobby backup limit is zero and that those features require Pro. That is the planning assumption. Confirm it on the workspace before relying on it. See the backup proposal below.

## 6. Environment variable matrix

`APP_ENV` is `development`, `staging`, or `production`. There is no `preview` value. A Vercel Preview deployment is a web build (`VERCEL_ENV=preview`). The app does not read `VERCEL_ENV` or `RAILWAY_*`. Preview web uses the **staging** API. It must not use production.

Secret means the value must live only in the platform's secret store or a local untracked env file. `scripts/check-no-secrets.mjs` fails CI if a tracked file contains a private key, an AWS access-key pattern, or a PostgreSQL URL whose password is not an allowed placeholder.

### 6.1 Vercel — `apps/web`

| Variable                   | Secret                                                            | Development                                          | Preview                              | Staging                            | Production                         |
| -------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------ | ---------------------------------- | ---------------------------------- |
| `NEXT_PUBLIC_API_BASE_URL` | No. Inlined in the browser bundle                                 | `http://127.0.0.1:4000`                              | Staging API origin, `https`, no path | `https://api.staging.<domain>`     | `https://api.<domain>`             |
| `API_PROXY_DESTINATION`    | Server-only. Not a password. Do not prefix it with `NEXT_PUBLIC_` | Unset. The route defaults to `http://127.0.0.1:4000` | Same staging origin as above         | Same as `NEXT_PUBLIC_API_BASE_URL` | Same as `NEXT_PUBLIC_API_BASE_URL` |
| `NODE_ENV`                 | No                                                                | `development` under `next dev`                       | `production` (Vercel build)          | `production`                       | `production`                       |

Set both URLs before the build. `NEXT_PUBLIC_API_BASE_URL` is frozen into the bundle. `API_PROXY_DESTINATION` is read per request, but it should still be set at build so the project is complete.

Not read by the code, so setting them does nothing today: `COOKIE_DOMAIN`, `NEXT_PUBLIC_WS_BASE_URL`, `VERCEL_ENV`, `VERCEL_URL`.

### 6.2 Railway — API

The worker, when it exists, uses the same table. It ignores `TRUST_PROXY`, `PORT`, and `HOST` for listening. Do not give the worker a public domain.

| Variable                                             | Secret                                                              | Development                                                  | Preview        | Staging                                                                                                                                                                                           | Production                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `APP_ENV`                                            | No                                                                  | `development`                                                | No preview API | `staging`                                                                                                                                                                                         | `production`                                                      |
| `HOST`                                               | No                                                                  | `127.0.0.1` (default)                                        | —              | `0.0.0.0`                                                                                                                                                                                         | `0.0.0.0`                                                         |
| `PORT`                                               | No                                                                  | `4000` (default). `0` only in development                    | —              | Injected by Railway                                                                                                                                                                               | Injected by Railway                                               |
| `LOG_LEVEL`                                          | No                                                                  | `info`                                                       | —              | `info`                                                                                                                                                                                            | `info`                                                            |
| `SERVICE_NAME`                                       | No                                                                  | `k2-api`                                                     | —              | `k2-api`                                                                                                                                                                                          | `k2-api`                                                          |
| `SERVICE_VERSION`                                    | No                                                                  | `0.1.0`                                                      | —              | Release version                                                                                                                                                                                   | Release version                                                   |
| `NODE_ENV`                                           | No                                                                  | `development`                                                | —              | `production`                                                                                                                                                                                      | `production`                                                      |
| `DATABASE_URL`                                       | **Yes**                                                             | Local `k2_dev`                                               | —              | Private Railway URL                                                                                                                                                                               | Private Railway URL                                               |
| `DATABASE_SSL`                                       | No                                                                  | `disable` for localhost                                      | —              | `disable` on `*.railway.internal` only                                                                                                                                                            | `disable` on `*.railway.internal` only                            |
| `DATABASE_POOL_MAX`                                  | No                                                                  | `10` (max 20)                                                | —              | `10`                                                                                                                                                                                              | `10` until a measured need                                        |
| `CORS_ORIGINS`                                       | No. It is a public origin list                                      | `http://127.0.0.1:3000`                                      | —              | `https://app.staging.<domain>` and, if preview HTTP is allowed, each preview origin that must call the API **from the browser**. The proxy does not need the preview origin for cookie forwarding | `https://app.<domain>` only                                       |
| `WEB_ORIGIN`                                         | No                                                                  | Default: first CORS origin                                   | —              | Staging web origin                                                                                                                                                                                | `https://app.<domain>`                                            |
| `MFA_ENCRYPTION_KEY`                                 | **Yes**                                                             | Unset uses a development fixture. `REPLACE_WITH` is rejected | —              | Unique 32-byte base64 key                                                                                                                                                                         | A different unique key. Never the staging key                     |
| `EMAIL_DELIVERY`                                     | No                                                                  | `capture` (default)                                          | —              | `unconfigured` or `smtp`                                                                                                                                                                          | `smtp` when mail is required. `capture` is rejected               |
| `EMAIL_OUTBOX_PATH`                                  | No. The file contains tokens                                        | Optional, gitignored                                         | —              | Unset                                                                                                                                                                                             | Unset                                                             |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, `SMTP_SECURE` | Host and from-address are not passwords. Treat the set as sensitive | Unset                                                        | —              | Set only when delivery is `smtp`                                                                                                                                                                  | Set only when delivery is `smtp`                                  |
| `SMTP_USER`, `SMTP_PASSWORD`                         | **Yes**                                                             | Unset                                                        | —              | Set together, or both unset                                                                                                                                                                       | Set together                                                      |
| `AUTH_LOGIN_DELAY_BASE_MS`                           | No                                                                  | `0`                                                          | —              | Default `250`. Minimum `200`                                                                                                                                                                      | Default `250`. Minimum `200`                                      |
| `AUTH_LOGIN_DELAY_CAP_MS`                            | No                                                                  | `0`                                                          | —              | Default `4000`, at least the base                                                                                                                                                                 | Default `4000`, at least the base                                 |
| `MARKET_DATA_MODE`                                   | No                                                                  | `disconnected` or `test-fixture`                             | —              | `disconnected`                                                                                                                                                                                    | `disconnected`                                                    |
| `TRUST_PROXY`                                        | No                                                                  | `false`                                                      | —              | `1` (in `.railway/railway.ts`)                                                                                                                                                                    | `1`, or a CIDR list once the proxy ranges are known. Never `true` |
| `TEST_DATABASE_URL`                                  | **Yes** (local/CI only)                                             | Test database name ending in `_test`                         | —              | Unset. Not read by the server                                                                                                                                                                     | Unset                                                             |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`  | **Yes**. CLI only                                                   | Local CLI                                                    | —              | Set only in the shell that runs the CLI, then remove them. Outside development, `BOOTSTRAP_ADMIN_CONFIRM=create-first-admin` is also required                                                     | Same. Never in the web project                                    |

Invalid configuration exits before listen. The stderr JSON lists `{ path, message }` and does not echo the value.

### 6.3 PostgreSQL placement and backups

**PROPOSED. Region and retention need founder approval. The database is not created.**

Placement:

- One Postgres service in the same Railway project and environment as the API, on Railway's private network.
- Region is a founder decision (data residency, OQ-084). Do not assume a region in the config file. `.railway/railway.ts` does not set one.
- The API uses the private URL. The public TCP proxy stays off unless an operator needs a one-off `psql` session, and that URL must not be committed.
- Staging and production are separate Railway environments and separate databases. Production data is not copied into staging. Preview has no database of its own and must not be given the production URL.
- Trial volume limit is 500 MB. Hobby's listed volume limit is 5 GB. A real market-data bar history can outgrow a trial disk. See Module 04's retention note before loading a large symbol set.

Backup proposal, to approve before any non-disposable data:

1. Use a Railway plan that includes volume backups and point-in-time recovery. The planning assumption is Pro, because staff replies say Hobby's backup limit is zero. Confirm on the account.
2. Turn on PostgreSQL point-in-time recovery (continuous WAL archive, about a four-week window in Railway's PITR document) and a volume schedule: daily, weekly, and monthly. Railway keeps daily backups 6 days, weekly 27 days, and monthly 89 days. Restores stay in the same project and environment.
3. Take an additional `pg_dump` on a schedule to storage **outside** that Railway project, encrypted, with a 30-day staging retention and a 90-day production retention. This is the copy that survives a project-level loss. The dump command is an owner procedure. It is not a script in this repository.
4. Run a restore drill before production traffic, and quarterly after that. Record who ran it and whether the restored database answered `/health`.
5. Wiping a Railway volume deletes its backups. Do not use a volume wipe as a rollback. Migrations roll forward, or use a reviewed down migration.
6. Backup files and dump credentials are secrets. They do not go into GitHub or the web project.

## 7. Cost, limits, and the 10,000-user target

Monitor before and after the first deploy:

- Vercel spend and function invocations. `/k2-api` turns every authenticated HTTP call into a function call plus an outbound request to Railway.
- Railway CPU, memory, egress, volume size, and backup storage. Set a hard usage limit so a loop stops the service instead of an open bill.
- Trial credit. $5 and 30 days is the published grant. When it ends, volumes are on a deletion timer unless the account is upgraded.
- Postgres connections. `DATABASE_POOL_MAX` is at most 20 per process. One API replica plus a future worker must stay under the database's connection cap.
- Log retention is 7 days on the trial and Hobby, 30 days on Pro. Audit rows in PostgreSQL are the durable record. Platform logs are not.

**10,000 concurrent active users is a design target, not a measured capacity.** The hosting decision says to design for that number and to treat it as unconfirmed until a load test. The earlier scale note (D-074) talks about ~10,000 registered traders and a smaller concurrent set. Neither figure has been load-tested.

What was actually run, in Module 04, is an in-process fan-out: 5,000 quotes to 4 consumers, and 1,000 quotes to 32 consumers, with a heap-growth bound. That is not 10,000 WebSocket sessions, not a multi-replica test, and not a test through Vercel or Railway. Do not quote 10,000 as a capacity this repository has demonstrated.

A credible test, later, needs a recorded market replay, a realistic mix of idle and active sessions, reconnect storms, and a pass line agreed with the founder. Until that exists, keep one API replica and do not autoscale.

## 8. What an owner does later

This sequence is not executed by this change.

1. Buy Vercel Pro or Enterprise, and a Railway plan that can hold a custom domain and backups. Do not use Vercel Hobby.
2. Choose the domain, region, and backup retention.
3. Create the Vercel project and the Railway `staging` environment. Set the variables in the matrix. Run `railway config plan`, read it, then `railway config apply`. Refuse a plan that mentions production or deletes a database.
4. Attach `app.staging.<domain>` and `api.staging.<domain>`. Confirm `/health`, a sign-in through `/k2-api`, the audit IP, and that a WebSocket to the Railway host receives the session cookie only after `COOKIE_DOMAIN` exists.
5. Leave production uncreated until staging has had a restore drill and the cookie domain is implemented.

The staging preparation steps in [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) still apply. Where this file is more specific, this file wins.

## 9. Founder decisions still required

| Decision                                    | Why it blocks                                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Registrable domain and DNS host             | Cookie `Domain`, `app` / `api` hostnames, and preview policy                                                      |
| Staging hostnames                           | Same cookie site as production or a staging-only parent domain                                                    |
| Vercel plan (Pro or Enterprise)             | Hobby forbids commercial use                                                                                      |
| Railway plan and spend cap                  | Trial data is deleted; Free has no custom domain; backups are assumed to need Pro                                 |
| PostgreSQL region                           | Data residency (OQ-084)                                                                                           |
| Backup retention and the off-platform dump  | The schedule above is a proposal                                                                                  |
| Whether preview web may use the staging API | Recommended yes for HTTP, never production. Authenticated preview sockets stay broken until the domain work lands |
| SMTP vendor                                 | Not required to boot. `unconfigured` is the staging placeholder                                                   |
