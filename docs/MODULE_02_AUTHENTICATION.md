# Module 02 — Authentication and user management

**Status:** Corrected on `cursor/correction-modules-02-04-82a0`. Not deployed. No Vercel or Railway resources were created.

## Correction — 2026-11-14

Founder-confirmed registration and access rules are now enforced. This section supersedes the earlier rows where they differ.

- Public registration requires first name, last name, unique username, email, password, country, city, street address, postal code, and phone. Phone is normalised to E.164 (`+` and digits). Structural E.164 is checked. A numbering-plan library is not used, and SMS verification is not required.
- A new trader stays unverified until the single-use hashed email token is consumed. Login is allowed. Challenge provisioning, own challenge-account routes, and market-data HTTP/WebSocket routes return `EMAIL_NOT_VERIFIED`. There is no separate account-status value for this gate, and no route can set `email_verified_at` except successful token consumption or the existing staff-invitation and bootstrap paths, which already proved control of the mailbox.
- Login accepts email and password, or username and password. Both use the same session, delay, and failure controls. Failures for a known account share one counter.
- `external_identities` stores a future provider subject. It has no email column and no insert path. Matching email text does not link an account. Google OAuth is not implemented.
- `staff.users.read` is held by `SUPPORT` and `ADMIN` only. It returns identity fields and omits phone and address. `staff.users.sensitive.read` is `ADMIN` only. A successful sensitive read is appended to `authentication_audit_events`. `FINANCE`, `RISK`, `TRADING_REVIEW`, `MANAGEMENT`, and `COMPLIANCE` do not receive either permission in this correction.
- `POST /staff/users/:id/mfa/reset` locks the target and refuses an account that has no staff role. A refused reset does not disable factors or revoke sessions. The refusal is audited.
- Role and status changes take a transaction advisory lock, then read the target roles under row locks. The last active `ADMIN` check uses those locked rows. Two concurrent removals of the only two administrators leave one administrator.
- The API process uses PostgreSQL `rate_limit_buckets` and `rate_limit_failures` unless a test injects the in-memory limiter. Limits are shared by API processes that use the same database. Redis was not added. Unit tests of the in-memory limiter still describe the window arithmetic. Untouched rate-limit rows are not purged by a scheduled job.

This document is the implementation record. The proposed identity sketch in [API_SPECIFICATION.md](./API_SPECIFICATION.md) and [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) stays proposed. Where this module differs, this file is the implemented contract.

## Implementation plan

Written from the Module 02 specification after inspecting `main` at `7f84f4528937c7f88235291cbe810c951ba3fc1a`.

- **Keep the stack.** Fastify 5, Next.js 16, PostgreSQL, Zod, the existing error handler, request ids, Pino redaction, and the checksummed migration runner. No Redis. `trustProxy` was left `false` in this module. The hosting task later made it `TRUST_PROXY`, still defaulting to off.
- **Do not edit `0001`.** Add `0002_identity_access` only.
- **Paths follow the module specification and the implemented `/health` style**, not the proposed `/v1` refresh-token sketch. Opaque server-side sessions replace access and refresh tokens.
- **Public registration always creates `TRADER`.** Request bodies are strict. `role`, `status`, and permissions are rejected, not ignored.
- **Account status is `ACTIVE`, `SUSPENDED`, or `CLOSED`.** Email verification is `email_verified_at`, not a status. Unverified traders may sign in. Suspended and closed accounts may not.
- **Sessions.** 32-byte tokens, SHA-256 hashes in PostgreSQL, HttpOnly `k2_session`, non-HttpOnly `k2_csrf`, `SameSite=Lax`, `Secure` outside development. Login rotates the presented session and does not adopt it. Password reset revokes every session.
- **CSRF.** State-changing requests require `x-k2-request: 1`. Authenticated state changes also require `x-csrf-token` equal to the `k2_csrf` cookie and to the hash stored on the session. The browser calls the API through the same-origin Next.js proxy `/k2-api`, so Lax cookies work on local HTTP.
- **Passwords.** Argon2id, minimum 12 characters, maximum 128. Unknown logins verify a dummy hash.
- **Email.** `EmailSender` with `capture` (development only), `unconfigured`, and generic SMTP. Production must set `EMAIL_DELIVERY` explicitly. Capture is rejected outside development. Unconfigured delivery returns HTTP 503 and does not report success.
- **MFA.** TOTP, AES-256-GCM at rest with `MFA_ENCRYPTION_KEY`, hashed single-use recovery codes. Staff routes require an enrolled factor and a session with `mfa_verified_at`. Traders are not forced to enroll. `mfa_verified_at` is the step-up marker for later payout work, which is not built here.
- **RBAC.** Explicit permissions. Only `ADMIN` can invite staff, change roles, change account status, or reset MFA. Support cannot. Traders have no `/users/:id` route. Staff reads use `/staff/users/:id`.
- **Audit.** `authentication_audit_events` is append-only. Staff invites, role changes, status changes, and MFA resets are audited. Privilege changes require the actor's password and current TOTP.
- **Tests.** Unit tests for hashing, encryption, TOTP, delays, and config. Integration tests on real PostgreSQL for the security cases in the specification. Existing foundation tests stay, with migration expectations updated to include `0002`.

No founder decision was invented for Challenge, KYC, payments, or SSO. Staff SSO stays out of scope. The permission grants and the durations below are engineering defaults and are labeled as such.

## Implemented

| Area             | Behavior                                                                                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration     | `POST /auth/register`. Email is trimmed and lower-cased. Duplicate addresses get the same HTTP 202 body and a mailbox notice without a second account.                                                                            |
| Verification     | Single-use hashed tokens, 24 hours. `POST /auth/email/verify` and `POST /auth/email/resend`.                                                                                                                                      |
| Login and logout | Generic 401 for a bad password or unknown email. 403 `ACCOUNT_UNAVAILABLE` after a correct password when status is not `ACTIVE`. Logout revokes the server session and clears cookies.                                            |
| Password reset   | `POST /auth/password/forgot` is generic. `POST /auth/password/reset` is single-use, expires in 1 hour, revokes sessions, and sends a notice through the email adapter.                                                            |
| Password change  | Current password, and a TOTP code when MFA is enrolled. Other sessions are revoked and the current session is rotated.                                                                                                            |
| Sessions         | `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `DELETE /auth/sessions` (all others). Expired and revoked tokens do not authenticate.                                                                                          |
| Profile          | `GET /users/me`, `PATCH /users/me`. The only self-service field is `displayName`. Email, status, roles, and verification cannot be patched.                                                                                       |
| MFA              | `POST /auth/mfa/enroll`, `/verify`, `/disable`, `/recovery`. Staff cannot disable MFA. Recovery codes work once.                                                                                                                  |
| Staff            | `POST /staff/invitations`, `POST /auth/invitations/accept`, `GET /staff/users/:id`, `POST /staff/users/:id/roles`, `POST /staff/users/:id/status`, `POST /staff/users/:id/mfa/reset`, `GET /staff/audit`.                         |
| Browser          | `/login`, `/register`, `/verify-email`, `/forgot-password`, `/reset-password`, `/account`, `/account/mfa`, `/invitations/accept`. No tokens in `localStorage` or `sessionStorage`. Email links put the token in the URL fragment. |

`GET /auth/me` returns the server-resolved profile, roles, permissions, and session id. The browser does not supply a user id or a role.

## Permission catalogue

Every role receives `profile.read`, `profile.update`, `session.list`, `session.revoke`, `password.change`, and `mfa.enroll`.

| Permission                                                                     | Who has it            |
| ------------------------------------------------------------------------------ | --------------------- |
| `staff.users.read`                                                             | `SUPPORT`, `ADMIN`    |
| `staff.users.sensitive.read`                                                   | `ADMIN` only          |
| `audit.read`                                                                   | `COMPLIANCE`, `ADMIN` |
| `staff.invite`, `staff.roles.assign`, `staff.status.change`, `staff.mfa.reset` | `ADMIN` only          |

This grant is an engineering least-privilege default. Widening `MANAGEMENT`, `FINANCE`, or another role is a later founder decision. It is data in `role_permissions`, not a hard-coded `isAdmin` check.

An actor cannot change their own roles or status. The last `ADMIN` cannot be removed, suspended, or closed. `CLOSED` does not return to `ACTIVE`. Suspension can be reactivated to `ACTIVE`.

## Engineering defaults

These are not founder business rules. They are the security parameters used because the specification required expiration and did not set the clocks.

| Control                 | Value                                                                                                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password                | 12–128 characters. No composition rules. Must not equal the email.                                                                                                                                        |
| Argon2id                | memoryCost 19456, timeCost 2, parallelism 1. Library default algorithm is Argon2id.                                                                                                                       |
| Session absolute / idle | 12 hours / 60 minutes                                                                                                                                                                                     |
| MFA challenge           | 5 minutes                                                                                                                                                                                                 |
| Email verification      | 24 hours                                                                                                                                                                                                  |
| Password reset          | 1 hour                                                                                                                                                                                                    |
| Staff invitation        | 48 hours                                                                                                                                                                                                  |
| Login failures          | 8 per 15 minutes per account, then HTTP 429. Progressive delay base 250 ms, cap 4 s, outside development. Development defaults the delay to 0 so tests stay fast; production rejects a base under 200 ms. |
| Registration            | 5 per hour per IP                                                                                                                                                                                         |
| Resend / forgot         | 3 per hour per account, plus an IP cap                                                                                                                                                                    |
| MFA codes               | 5 failures per 5 minutes per user                                                                                                                                                                         |

## Security controls

1. Argon2id password hashes. Plaintext passwords are not stored.
2. Verification, reset, session, and recovery values are stored as SHA-256 hashes.
3. TOTP secrets are AES-256-GCM with the user id as additional data. The key is `MFA_ENCRYPTION_KEY` (32 bytes, base64). The all-`0x01` development fixture is rejected outside development.
4. Cookies: HttpOnly session, `Secure` outside development, `SameSite=Lax`, `Path=/`.
5. CSRF header plus a session-bound double-submit token.
6. CORS stays on the configured origin list, with credentials, and now allows `GET`, `POST`, `PATCH`, `DELETE`, and `OPTIONS`. `*` is still rejected.
7. Production rate limits are rows in PostgreSQL, locked per key. They are shared by API processes that use the same database and survive a process restart. Redis was not added. Tests may still inject the in-memory limiter. Multi-instance deployment is not blocked by process-local limits. A scheduled purge of untouched keys is not implemented.
8. Login and reset responses do not reveal whether an email exists. A correct password on a suspended or closed account returns one message for both statuses.
9. Login replaces any presented session. A revoked or expired hash cannot be reused.
10. Authorization is loaded from PostgreSQL on each request. Object checks: session revoke and profile updates are limited to the signed-in user. A missing or foreign session id is HTTP 404.
11. Staff actions listed above are written to `authentication_audit_events`. A trigger rejects `UPDATE` and `DELETE` on that table.
12. Logs redact passwords, tokens, cookies, authorization, MFA material, and connection strings. Request logs drop query strings. Email links use a fragment so the web server does not receive the token.
13. No staff password is in git. Bootstrap is a CLI, not an HTTP route, and it refuses to run twice.

`TRUST_PROXY` defaults to off. If it stays off behind Railway, every client shares the proxy address for rate limits. The hosting task accepts `1` through `5` or a CIDR list and rejects `true`. The staging file sets `1`. See [DEPLOYMENT_ARCHITECTURE.md](./DEPLOYMENT_ARCHITECTURE.md).

## Email

| `EMAIL_DELIVERY` | Behavior                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `capture`        | Development only. Messages stay in process memory and, when `EMAIL_OUTBOX_PATH` is set, in that file. The file is gitignored. |
| `unconfigured`   | Allowed in every environment. Sends fail with HTTP 503.                                                                       |
| `smtp`           | Generic SMTP via `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, and optional `SMTP_USER` / `SMTP_PASSWORD`. No vendor is hard-coded.  |

If `capture` or `smtp` is not selected, registration, resend, forgot, and invite do not pretend that a message was sent. A reset or password change that already succeeded reports `notification: "unavailable"` when the notice cannot be sent.

The first `CORS_ORIGINS` entry is the link origin unless `WEB_ORIGIN` is set to one of those origins.

## Staff bootstrap

There is no default administrator and no HTTP bootstrap.

```bash
BOOTSTRAP_ADMIN_EMAIL='person@example.com' \
BOOTSTRAP_ADMIN_PASSWORD='a-long-unique-password' \
npm run bootstrap:staff -w @k2/api
```

Outside development, also set `BOOTSTRAP_ADMIN_CONFIRM=create-first-admin`. The command prints the user id and not the password. It refuses when an `ADMIN` already exists, when the email is taken, or when the password is shorter than 12 characters or is a known placeholder. The new administrator must enroll MFA before staff routes work.

Do not commit these variables.

## Not implemented

- Third-party SSO and a separate staff origin.
- WebAuthn, SMS, breached-password lists, and new-device mail.
- KYC, payments, Challenges, trading, payouts, and step-up enforcement on those flows.
- Google OAuth and any automatic email-based account link.
- A numbering-plan check beyond structural E.164.
- A scheduled purge of untouched rate-limit rows.
- Production deployment.

## Files

Migration `apps/api/db/migrations/0002_identity_access`. HTTP and rules under `apps/api/src/modules/auth`. SQL in `apps/api/src/infrastructure/db/identity-repository.ts`. Shared response schemas in `packages/shared/src/auth.ts`. Browser pages under `apps/web/app` and the proxy `apps/web/app/k2-api/[...path]/route.ts`.
