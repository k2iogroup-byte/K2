# Deployment guide

The founder hosting decision and the service map are in [DEPLOYMENT_ARCHITECTURE.md](./DEPLOYMENT_ARCHITECTURE.md). This file is the staging preparation sequence. Where the two differ, the architecture document wins.

Module 01 prepares staging and does not create it. No Vercel project, Railway project, database, or domain was created. There are no credentials in this environment. Staging deployment is **pending owner credentials**.

Production deployment is out of scope. The workflow in `.github/workflows/ci.yml` has no deploy job. `.railway/railway.ts` throws unless the linked Railway environment is named exactly `staging`.

## What is committed

| File                       | Role                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `apps/web/vercel.json`     | Install and build the npm workspace from the repository root when the Vercel root directory is `apps/web` |
| `.railway/railway.ts`      | Staging API service, Postgres, build, pre-deploy migration, `/health`                                     |
| `.github/workflows/ci.yml` | Checks only                                                                                               |

`railway.toml` is not used. Railway’s config-as-code file is deprecated for new services. The current file is `.railway/railway.ts`, evaluated by the Railway CLI. It is not read automatically on git push. Nothing deploys until an owner runs `railway config plan` and then `railway config apply`.

## Cost, before anyone creates an account

Confirm current prices. These are planning ranges, not quotes, and no spend has occurred.

| Piece            | Driver                                                                                                                              | Planning range                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Vercel frontend  | Commercial plan. Hobby is not appropriate for a firm. Pro has historically started near $20 per developer seat per month plus usage | Low tens of dollars per month for this shell                |
| Railway API      | One small container                                                                                                                 | A few dollars to the low tens                               |
| Railway Postgres | Small disk, private networking, backups if enabled                                                                                  | A few dollars to the low tens                               |
| Redis            | Not deployed                                                                                                                        | $0                                                          |
| GitHub Actions   | A short TypeScript workflow                                                                                                         | Included minutes for a small private repo; confirm the plan |

Market-data licences, a broker, and a payment processor are not staging costs for this module.

## Order of operations for the owner

1. Merge Module 01 only after the CI jobs are green, and after branch protection requires them (see below). The Railway source branch in the infrastructure file is `main`, with `checkSuites: true`, so a staging deploy waits on GitHub checks when that feature is enabled for the service.
2. Create a Vercel project from this GitHub repository.
   - Root Directory: `apps/web`
   - Framework: Next.js
   - The committed `apps/web/vercel.json` runs `npm ci` and the shared-package build from the repository root.
   - `NEXT_PUBLIC_API_BASE_URL` = the Railway API origin, including `https`, with no path. It is public and it is inlined at build time. Set it, then build.
   - `API_PROXY_DESTINATION` = the same origin. It is server-only. The `/k2-api` route reads it. Do not put a password in it.
   - Do not attach a production domain in this module. Use `app.<domain>` and `api.<domain>` only after the domain in DEPLOYMENT_ARCHITECTURE.md is chosen. Do not rely on `*.vercel.app` plus `*.railway.app` for the session cookie.
3. Install the Railway CLI (3.17 or newer for this file’s `railway/iac` import). Authenticate as the owner.
4. Create a Railway project and an environment named `staging`. Link the CLI to that environment. Do not link an environment named `production`. `railway config plan` will throw if you do.
5. Set these on the API service before the first apply. The infrastructure file uses `preserve()` so a later apply does not wipe them. The process exits before listen if any required value is missing, and the health check then fails.
   - `CORS_ORIGINS`: the exact Vercel origin (`https://…`, no path, no trailing slash). Do not use `*`.
   - `WEB_ORIGIN`: the same origin. Email links use it.
   - `MFA_ENCRYPTION_KEY`: a 32-byte key, base64, generated locally. Do not commit it.
   - `EMAIL_DELIVERY`: `unconfigured` until an SMTP vendor exists.
   - `TRUST_PROXY` is already `1` in the file. Do not change it to `true`.
6. From the repository root, against the staging link:

   ```bash
   railway config plan
   railway config apply
   ```

   Read the plan. It should add Postgres (`postgres`) and the API service (`api`) only. Do not confirm a plan that deletes unrelated resources or mentions production.

7. The API build command is `npm run build -w @k2/shared && npm run build -w @k2/api`. The pre-deploy command is `npm run db:migrate -w @k2/api`. The start command is `npm run start -w @k2/api`. Health check path: `/health`, timeout 120 seconds.
8. Private `DATABASE_URL` is wired from the Postgres service. `DATABASE_SSL=disable` matches that private host. Do not replace it with the public proxy URL unless you also set `DATABASE_SSL` to `no-verify` or `verify`.
9. After the deploy is healthy, open `https://<railway-domain>/health`. Expect HTTP 200, `"status":"ok"`, `"environment":"staging"`, and `"schemaVersion":"0001"`. Then open the Vercel URL and confirm the page shows **Operational** and schema `0001`.

The worker is not a Railway service. It would cost money while idle and has no jobs.

## Safe migrations

- SQL files live in `apps/api/db/migrations/` as `NNNN_name.up.sql` and `NNNN_name.down.sql`.
- The runner stores a SHA-256 checksum of the up file. Editing an applied file fails the next migrate. Add a new file instead.
- Up and down each run in one transaction. PostgreSQL DDL rolls back with the transaction.
- The API process does not migrate on startup. A replica cannot apply DDL while another replica is serving.
- Railway runs the migration as a pre-deploy command in a separate container. If it exits non-zero, the deployment stops and the previous release keeps serving.
- Roll back one migration locally with `npm run db:rollback`. On staging, roll back only with a reviewed down migration or a forward fix. Do not drop the Railway volume to “undo” a migration.
- `schema_migrations` is created by the runner and is not dropped by `0001`’s down file.

## Health

`GET /health` returns 200 only when PostgreSQL answers and `foundation_schema_info` has schema version `0001`. Otherwise it returns 503 and `"status":"degraded"`. The body has no connection string. `Cache-Control` is `no-store`.

Railway uses this path to decide the new deployment is ready. It is a readiness check for this module, not a full production monitor. Uptime checks, paging, and a status page belong to a later infrastructure module.

## Branch protection

The repository owner should require these status checks before merging to `main`:

- `Install, typecheck, lint, unit tests, build, audit`
- `Integration tests`

Also require a pull request and at least one review. Module 01 cannot change those settings. Until they are on, do not enable automatic deploys from `main`.

## What a failed staging plan looks like

If `railway config plan` asks to create production, stop. If it wants to delete a database, stop. If the API origin and `CORS_ORIGINS` disagree, the browser health panel will say the API is unreachable even though `curl` from a server succeeds. Fix the origin; do not set `CORS_ORIGINS` to `*`.
