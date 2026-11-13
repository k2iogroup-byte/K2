# Testing guide

Tests are executable. They are not a claim that the future trading platform is tested.

## Commands

```bash
npm run test:unit
npm run test:coverage
npm run test:integration
npx playwright install chromium   # once per machine
npm run test:e2e
```

`npm run test:e2e` builds all packages, applies migrations to the development database, and runs Playwright against the production servers it starts itself.

## Layout

| Path                                         | Kind           | Database                               |
| -------------------------------------------- | -------------- | -------------------------------------- |
| `apps/api/test/unit`                         | API unit tests | None. Health uses an in-memory probe   |
| `packages/shared/test`                       | Contract tests | None                                   |
| `apps/web/lib/api-base-url.test.ts`          | Web unit test  | None                                   |
| `apps/api/test/integration/database.test.ts` | Integration    | `TEST_DATABASE_URL` only               |
| `apps/web/e2e/foundation.spec.ts`            | End-to-end     | Development database, already migrated |

## What the initial tests cover

The module specification asks for tests of startup, the health endpoint, database connectivity, configuration validation, and centralized error handling.

| Requirement                | Where it is tested                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Application startup        | Unit: `startServer` rejects an invalid port before listening. Unit: `buildApp` listens and serves `/health`. Integration: `startServer` listens on a real pool                                               |
| API health                 | Unit: 200 with a fake migrated database, 503 when the probe is down, 503 when the schema is missing. Integration: the same transitions against PostgreSQL. End-to-end: the page shows Operational and `0001` |
| Database connectivity      | Integration: `SELECT` through the pool, migration up, worker start                                                                                                                                           |
| Configuration validation   | Unit: missing variables, placeholder password, production TLS and CORS rules, ephemeral port. Error text must not contain the password                                                                       |
| Centralized error handling | Unit: an unexpected error becomes HTTP 500 with `Internal server error`, the body and the log omit the connection string, 404 has a stable body, invalid query parameters are not echoed                     |

Additional tests that belong to the security baseline: security headers, CORS allow and deny, a 16 KB body limit, WebSocket ping and rejection of any other message, migration file pairing, checksum mismatch, a failed migration rolling back, the migration CLI, env-file loading that does not override the process, and log redaction.

Integration tests call `DROP SCHEMA public CASCADE` on the test database. `assert` logic refuses any database name that does not end with `_test`.

## Coverage

`npm run test:coverage` writes a text summary and an HTML report under `coverage/` (gitignored). The report is the unit-test run. Integration tests are a separate process and are not merged into that percentage. Database pool, probe, and migration execution are covered by the integration file; the unit percentage under-counts them on purpose so the unit job does not need PostgreSQL.

On the Module 01 verification run the unit report was approximately 61% lines, 67% branches, and 69% functions across `apps/api/src`, `packages/shared/src`, and `apps/web/lib`. There is no numeric gate. A gate that ignored the integration suite would punish the split. Read the uncovered-line table when a change touches config, errors, or health.

## CI

Pull requests run:

1. `npm ci`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run test:coverage`
5. `npm run build`
6. `npm audit --audit-level=high`
7. `node scripts/check-no-secrets.mjs`
8. Integration tests, in a second job, with a PostgreSQL 16 service and database `k2_test`

End-to-end tests are not in CI in this module. They need a browser download and a longer job. Run them before asking for review. Promoting them into CI is a later change, not a silent gap in the local suite.

## End-to-end scope

Playwright loads `/` on a 1280×800 Chromium viewport and on a Pixel 7 viewport. It expects the heading `K2 Group`, the sentence that this module does not provide accounts, payments, or trading, the status text `Operational`, the schema id `0001`, and no horizontal overflow.

That is a foundation smoke test. It is not a trading, login, or payment journey.
