# Repository structure

This document describes the directories that exist after Module 01. It does not create folders for later business modules.

## Tree

```text
.
├── apps/
│   ├── api/                 Fastify API (modular monolith)
│   │   ├── db/migrations/   Versioned SQL, up and down
│   │   └── src/
│   │       ├── config/      Startup validation and env files
│   │       ├── infrastructure/
│   │       │   ├── db/      Pool, probe, migration runner
│   │       │   ├── http/    Errors, validation, CORS origin checks
│   │       │   ├── logging/ Structured logs and redaction
│   │       │   └── ws/      WebSocket endpoint
│   │       ├── modules/
│   │       │   ├── auth/    Registration, sessions, MFA, staff access
│   │       │   └── health/  Infrastructure health
│   │       └── runtime/     Process entry helpers
│   └── web/                 Next.js frontend
│       ├── app/             App Router shell
│       ├── components/      Health panel and service-worker registration
│       ├── e2e/             Playwright tests
│       ├── lib/             Browser-side API origin parsing
│       └── public/          PWA manifest, icon, service worker
├── packages/
│   └── shared/              Zod contracts used by the API and the web app
├── docs/                    Business documents plus Module 01 technical guides
├── .github/workflows/       Pull-request CI. No deploy job.
├── .railway/                Staging infrastructure definition. Not applied.
└── scripts/                 Tracked-file secret check
```

## Why these boundaries

| Directory                        | Responsibility                                            | What it must not do                      |
| -------------------------------- | --------------------------------------------------------- | ---------------------------------------- |
| `apps/web`                       | Render the shell, call the API, register a service worker | Business rules, database access, secrets |
| `apps/api/src/modules`           | HTTP behavior for one capability                          | SQL, other than through an interface     |
| `apps/api/src/infrastructure/db` | Connections, migrations, the database probe               | Challenge, account, or ledger rules      |
| `packages/shared`                | Request and response contracts                            | Server-only code, database drivers       |
| `docs`                           | Confirmed business rules and technical decisions          | Runnable schema or trading logic         |

The health module depends on a `DatabaseProbe` interface. The PostgreSQL implementation lives under `infrastructure/db`. A unit test can replace the probe without opening a database.

`packages/shared` exists because the health payload and the API error body are a boundary between two processes. One schema is parsed by the API before it sends the body and by the browser before it renders it.

## What is intentionally absent

Module 02 adds `apps/api/src/modules/auth`. Module 03 adds `apps/api/src/modules/accounts` for the challenge catalogue, rule-set versions, and account lifecycle. Module 04 adds `apps/api/src/modules/market-data` for normalised quotes, bars, and feed health. There is still no payments, trading, risk, or ledger module. There is no Redis client and no message broker. Module 01 database objects remain `schema_migrations` and `foundation_schema_info`. Module 02 adds the identity tables in migration `0002_identity_access`. Module 03 adds the catalogue and account tables in migration `0003_challenge_accounts`. Module 04 adds market-data tables in migration `0004_market_data`. Account and market-data SQL live in their modules so `infrastructure/db` does not own those rules.

## Naming

| Kind        | Convention                          | Example                             |
| ----------- | ----------------------------------- | ----------------------------------- |
| Files       | kebab-case, or a dotted role suffix | `health-route.ts`, `migrate-cli.ts` |
| Types       | PascalCase                          | `AppConfig`                         |
| Functions   | camelCase                           | `loadConfig`                        |
| Constants   | SCREAMING_SNAKE when truly constant | `REDACT_PATHS`                      |
| Database    | snake_case                          | `foundation_schema_info`            |
| Environment | SCREAMING_SNAKE                     | `DATABASE_URL`                      |
| Packages    | `@k2/api`, `@k2/web`, `@k2/shared`  | workspace names                     |

## Error handling

Expected failures throw `AppError` with a stable code and a message that is safe to show to a caller. Unexpected failures become HTTP 500 with the message `Internal server error`. The server log receives the error name and a redacted message. Stack traces, SQL, and configuration values are not written to the response.

Validation failures use `parseWithSchema`. The response lists the field path and the fixed text `Invalid value`. The received value is not copied into the response or the error message.

## Background process

`apps/api/src/worker.ts` is a second process entry. Module 01 registers no jobs (`REGISTERED_JOBS` is empty). The process checks that the database is reachable and migrated, then waits for SIGTERM. It is not part of the default `npm run dev` or the Railway service. A later module can append a job name and run `npm run start:worker` as its own process without splitting the codebase into a separate service repository.
