# Development setup

These steps are what another developer needs on a clean machine. They were run on the Module 01 verification machine (Node.js 22.23.4, npm 10.9.9, PostgreSQL 16.15).

## 1. Install tools

- Node.js 22.13 or newer (`node -v`). The repository pins `22` in `.nvmrc`.
- npm 10, matching the `packageManager` field.
- PostgreSQL 16. The API does not embed a database.

On Debian or Ubuntu, if the service does not start under a restricted policy, start the cluster directly:

```bash
sudo apt-get update
sudo apt-get install -y postgresql postgresql-contrib
sudo pg_ctlcluster 16 main start
```

## 2. Create two local databases

Use a password you generate. Do not reuse `REPLACE_WITH_LOCAL_PASSWORD`, `password`, or the CI fixture `k2_ci_test_password`. Twelve characters is the minimum the API accepts.

```bash
sudo -u postgres psql -c "CREATE ROLE k2 LOGIN PASSWORD 'paste-a-long-local-password';"
sudo -u postgres createdb -O k2 k2_dev
sudo -u postgres createdb -O k2 k2_test
```

`k2_dev` is for the running API. `k2_test` is for integration tests. Integration tests drop the `public` schema. They refuse a database whose name does not end in `_test`.

Connect over TCP so password authentication is used:

```bash
psql "postgresql://k2:REPLACE_WITH_LOCAL_PASSWORD@127.0.0.1:5432/k2_dev" -c 'SELECT current_user;'
```

Substitute the password you just created for `REPLACE_WITH_LOCAL_PASSWORD`. The API rejects that placeholder if it is left in `DATABASE_URL`.

## 3. Configure environment files

From the repository root:

```bash
npm ci
cp .env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
```

Edit `apps/api/.env`. Replace both `REPLACE_WITH_LOCAL_PASSWORD` values. Leave `APP_ENV=development`, `DATABASE_SSL=disable`, and the localhost CORS origins. Do not commit either copy. `.gitignore` ignores `.env` and `.env.*` except `*.example`.

`apps/web/.env.local` only sets `NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4000`. That value is public. It is embedded in the browser bundle. Do not put a password in any `NEXT_PUBLIC_` variable.

## 4. Migrate and start

```bash
npm run db:migrate
npm run dev
```

`npm run db:migrate` applies pending SQL. Running it again prints `no pending migrations`.

- API: http://127.0.0.1:4000/health
- Web: http://127.0.0.1:3000

A healthy body has `"status":"ok"` and `"schemaVersion":"0001"`. If the database is up but migrations have not been applied, the status is `degraded` and the HTTP status is 503.

Stop the processes with Ctrl+C. `npm run dev` starts both. You can start one side with `npm run dev:api` or `npm run dev:web`.

## 5. Quality commands

| Command                    | What it does                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `npm run typecheck`        | Builds `@k2/shared`, then strict-checks API, web, shared, and `.railway/railway.ts`          |
| `npm run lint`             | ESLint and Prettier                                                                          |
| `npm run test:unit`        | Unit tests. No database                                                                      |
| `npm run test:coverage`    | Unit tests plus a v8 coverage report                                                         |
| `npm run test:integration` | Real PostgreSQL. Uses `TEST_DATABASE_URL`                                                    |
| `npm run test:e2e`         | Production build, migrate, Playwright on desktop and a phone viewport                        |
| `npm run build`            | Shared package, API, and Next.js production build                                            |
| `npm run audit`            | `npm audit` failing on high or critical advisories                                           |
| `npm run check:secrets`    | Fails if a tracked file contains a private key or a database URL with an unexpected password |
| `npm run db:status`        | Lists migrations                                                                             |
| `npm run db:rollback`      | Rolls back the latest migration only                                                         |
| `npm run start:api`        | Runs the compiled API (`node dist/index.js`)                                                 |
| `npm run start:web`        | Runs the compiled Next.js server                                                             |
| `npm run start:worker`     | Compiled idle worker. No jobs in Module 01                                                   |

Before `npm run test:e2e`, install a browser once:

```bash
npx playwright install chromium
```

## 6. Rollback check

```bash
npm run db:rollback
npm run db:status
npm run db:migrate
```

`npm run db:rollback` removes only the latest migration. After Module 03, the first rollback removes `0003`, the next removes `0002`, and the next removes `0001`. The bookkeeping table `schema_migrations` remains. `/health` still reports schema `0001` while `foundation_schema_info` is present, and 503 after that row is gone.

## Troubleshooting

| Symptom                                                     | Check                                                                                                |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `password does not meet the baseline`                       | The password is shorter than 12 characters or is a placeholder such as `REPLACE_WITH_LOCAL_PASSWORD` |
| `password authentication failed`                            | The role password and `DATABASE_URL` disagree, or the URL uses a socket instead of `127.0.0.1`       |
| Health is `degraded` with database `up` and schema `null`   | Run `npm run db:migrate`                                                                             |
| Health is unreachable from the page                         | The API is not on port 4000, or `NEXT_PUBLIC_API_BASE_URL` was missing when the web app was built    |
| Integration tests refuse to start                           | `TEST_DATABASE_URL` is missing or its database name does not end with `_test`                        |
| `npm run typecheck` on the web app cannot find `@k2/shared` | Run `npm run build -w @k2/shared` first. The root `typecheck` and `build` scripts do this            |

The API reads `apps/api/.env` and does not override variables that are already set. A shell export wins over the file. That is how CI and Playwright inject the test database without editing the file.
