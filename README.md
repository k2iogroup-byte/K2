# K2 Group

K2 Group is an international proprietary trading firm in development. This repository holds the business documentation and the Module 01 technical foundation for a web-based Challenge platform.

Module 01 is a modular monolith with a separate frontend and backend. Module 02 adds authentication and user management. The repository does not implement payments, trading, or Challenge rules. Confirmed business rules stay in `docs/` and were not rewritten by these modules. See [docs/MODULE_02_AUTHENTICATION.md](docs/MODULE_02_AUTHENTICATION.md).

## Start here

| Document                                                               | Purpose                                            |
| ---------------------------------------------------------------------- | -------------------------------------------------- |
| [docs/DEVELOPMENT_SETUP.md](docs/DEVELOPMENT_SETUP.md)                 | Clone, configure, and run the applications         |
| [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md)                 | What each directory is for                         |
| [docs/TECH_STACK_DECISIONS.md](docs/TECH_STACK_DECISIONS.md)           | Stack choices, alternatives, cost, and scaling     |
| [docs/ARCHITECTURE_DECISIONS.md](docs/ARCHITECTURE_DECISIONS.md)       | Architecture decisions and the security baseline   |
| [docs/ENVIRONMENT_CONFIGURATION.md](docs/ENVIRONMENT_CONFIGURATION.md) | Development, staging, and production configuration |
| [docs/TESTING_GUIDE.md](docs/TESTING_GUIDE.md)                         | Unit, integration, and end-to-end tests            |
| [docs/DEPLOYMENT_GUIDE.md](docs/DEPLOYMENT_GUIDE.md)                   | Staging deploy preparation for Vercel and Railway  |
| [docs/README.md](docs/README.md)                                       | Business documentation index                       |

## Run locally

Requirements: Node.js 22, npm 10, and PostgreSQL 16. Details and the database setup are in the development guide.

```bash
npm ci
cp .env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
# Replace REPLACE_WITH_LOCAL_PASSWORD in apps/api/.env, then:
npm run db:migrate
npm run dev
```

- Frontend: http://127.0.0.1:3000
- API health: http://127.0.0.1:4000/health

## Checks

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
npm run build
npm run audit
```

`npm run test:e2e` needs Playwright Chromium (`npx playwright install chromium`) and a migrated development database.

## Status of technology choices

PostgreSQL, TypeScript, a separate frontend and backend, GitHub Actions, and the security baseline in this module are required by the Module 01 specification. React/Next.js and Vercel/Railway were candidates in the founder brief. They are implemented here as **PROPOSED** engineering selections. Open questions OQ-070 and OQ-071 in the business documents are not closed.
