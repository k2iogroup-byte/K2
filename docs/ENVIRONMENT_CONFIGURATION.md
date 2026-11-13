# Environment configuration

Three environments exist as configuration, not as hosted accounts. The service map, preview rules, and the full per-environment matrix are in [DEPLOYMENT_ARCHITECTURE.md](./DEPLOYMENT_ARCHITECTURE.md). Preview is a Vercel deployment class, not an `APP_ENV`.

| Environment | `APP_ENV`     | Where it runs                                                           | Database                            |
| ----------- | ------------- | ----------------------------------------------------------------------- | ----------------------------------- |
| Development | `development` | A developer machine                                                     | Local `k2_dev`, tests use `k2_test` |
| Staging     | `staging`     | Vercel (web) and Railway (API + Postgres), after the owner creates them | Railway private Postgres            |
| Production  | `production`  | Not created in Module 01                                                | Not created                         |

`APP_ENV` is the application environment. `NODE_ENV` is the Node/Next build mode. Staging and production run with `NODE_ENV=production` so dependencies use their production paths. Do not point staging at a development database.

## Files

| File                    | Committed | Contents                                                     |
| ----------------------- | --------- | ------------------------------------------------------------ |
| `.env.example`          | Yes       | API template. Password text is `REPLACE_WITH_LOCAL_PASSWORD` |
| `apps/web/.env.example` | Yes       | `NEXT_PUBLIC_API_BASE_URL` only                              |
| `apps/api/.env`         | No        | Local API configuration                                      |
| `apps/web/.env.local`   | No        | Local public API origin                                      |
| Hosting dashboards      | No        | Staging and production secrets                               |

The API loads `apps/api/.env` if that file exists, otherwise the repository-root `.env`. Existing process environment variables are kept. The file cannot override CI or the platform.

Production and staging secrets stay in Vercel and Railway. They are not copied into git. `scripts/check-no-secrets.mjs` fails the CI job if a tracked file contains a private key, an AWS access-key pattern, or a PostgreSQL URL whose password is not an allowed placeholder. The CI workflow’s `k2_ci_test_password` is allowed only in `.github/workflows/ci.yml`. It is a throwaway password for a database that exists only inside the GitHub-hosted runner. Do not reuse it anywhere else. The validator rejects that password when `APP_ENV` is `staging` or `production`.

## API variables

| Variable                                              | Required                   | Rules                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`                                             | Yes                        | `development`, `staging`, or `production`                                                                                                                                                                                                                                             |
| `DATABASE_URL`                                        | Yes                        | `postgres://` or `postgresql://`, with user, password, and database name                                                                                                                                                                                                              |
| `DATABASE_SSL`                                        | Yes                        | `disable`, `no-verify`, or `verify`                                                                                                                                                                                                                                                   |
| `CORS_ORIGINS`                                        | Yes                        | Comma-separated origins. `*` is rejected. No paths, queries, or userinfo                                                                                                                                                                                                              |
| `HOST`                                                | No                         | Default `127.0.0.1` in development and `0.0.0.0` otherwise                                                                                                                                                                                                                            |
| `PORT`                                                | No                         | Default `4000`. `0` is allowed only in development (ephemeral test ports)                                                                                                                                                                                                             |
| `LOG_LEVEL`                                           | No                         | Default `info`                                                                                                                                                                                                                                                                        |
| `SERVICE_NAME`                                        | No                         | Default `k2-api`. Lowercase letters, digits, hyphens                                                                                                                                                                                                                                  |
| `SERVICE_VERSION`                                     | No                         | Default `0.1.0`                                                                                                                                                                                                                                                                       |
| `DATABASE_POOL_MAX`                                   | No                         | Default `10`, maximum `20`                                                                                                                                                                                                                                                            |
| `TEST_DATABASE_URL`                                   | Tests only                 | Not read by the server. Database name must end with `_test`                                                                                                                                                                                                                           |
| `MFA_ENCRYPTION_KEY`                                  | Yes outside development    | Base64 encoding of 32 bytes. In development, an unset key uses a fixture of 32 `0x01` bytes, which is rejected in staging and production. `REPLACE_WITH` is rejected everywhere.                                                                                                      |
| `EMAIL_DELIVERY`                                      | Yes outside development    | `capture` (development only), `unconfigured`, or `smtp`. Unset development defaults to `capture`.                                                                                                                                                                                     |
| `EMAIL_OUTBOX_PATH`                                   | No                         | Capture mode only. Gitignored mailbox file. Tokens are in the file, not in logs.                                                                                                                                                                                                      |
| `WEB_ORIGIN`                                          | No                         | Email-link origin. Must be one of `CORS_ORIGINS`. Defaults to the first origin.                                                                                                                                                                                                       |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`                 | When `EMAIL_DELIVERY=smtp` | Generic SMTP. Optional `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`.                                                                                                                                                                                                                   |
| `AUTH_LOGIN_DELAY_BASE_MS`, `AUTH_LOGIN_DELAY_CAP_MS` | No                         | Progressive login delay. Development default is 0. Outside development the base must be at least 200 ms and the cap must be at least the base. Default outside development is 250 / 4000.                                                                                             |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`   | CLI only                   | Not read by the server. Never commit them. Outside development, `BOOTSTRAP_ADMIN_CONFIRM=create-first-admin` is also required.                                                                                                                                                        |
| `TRUST_PROXY`                                         | No                         | `false` (default), a hop count from 1 to 5, or a comma-separated list of IPs or CIDRs. `true` is rejected. Development stays `false`. Staging sets `1` because Railway's edge is one hop. A hop count does not check the peer address. Prefer a CIDR when the proxy ranges are known. |

Password rules, applied without putting the password in the error text:

- At least 12 characters.
- Rejected if it is `password`, `changeme`, `secret`, `postgres`, `k2`, or contains `replace_with`.
- Outside development, `k2_ci_test_password` is rejected.
- Outside development, the host cannot be localhost.
- Outside development, `DATABASE_SSL=disable` is allowed only when the host ends with `.railway.internal` or `.internal`. Public hosts must use `no-verify` or `verify`.

`no-verify` encrypts the connection and does not check the server certificate. Prefer `verify` when the provider gives a CA. Railway’s private hostname does not use TLS; `disable` is the matching setting for `DATABASE_URL` from the private network. A public proxy URL is a different host and must not use `disable`.

CORS origins must be `https` when `APP_ENV` is `staging` or `production`.

Invalid configuration stops the process before it listens. The stderr line is JSON with `event` `invalid_configuration` and a list of `{ path, message }`. The message does not include the received value.

## Web variable

`NEXT_PUBLIC_API_BASE_URL` is an origin such as `http://127.0.0.1:4000` or `https://the-railway-domain`. Next.js inlines it at build time. Set it in the Vercel project before building. The page still renders if it is missing; the health panel says the variable is not set. The parser drops any path and rejects embedded credentials.

Authentication pages call `/k2-api` on the web origin. The Next.js route proxies to `API_PROXY_DESTINATION` (default `http://127.0.0.1:4000`). That variable is server-side. Do not put a password in it. On Vercel set it to the public Railway origin. The session cookie is set on the web host. Split `*.vercel.app` and `*.railway.app` hosts do not share it. See [DEPLOYMENT_ARCHITECTURE.md](./DEPLOYMENT_ARCHITECTURE.md).

## What is not logged

Startup and request logs include the service name, environment, host, port, method, path, status, and request id. They do not include `DATABASE_URL`, passwords, cookies, authorization headers, or query strings. A connection string or `Bearer` token that appears inside an error message is replaced with `[REDACTED]` before it is written.

## Production

Production uses the same variable names and stricter rules above. It is not provisioned. Do not copy a production URL into a development file. Do not copy a production database into staging. The architecture note that production financial data is never copied unmasked into lower environments still stands; Module 01 has no financial data to copy.
