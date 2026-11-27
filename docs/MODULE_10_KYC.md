# Module 10 — KYC

**Status:** Implemented 2026-11-27 as a sandbox. No real KYC vendor. The sandbox stores a provider document id and a status. It does not store document contents. Anti-fraud, sanctions, and device checks are not in this module.

## Lifecycle

No row means `NOT_STARTED`. `submitDocuments` stores provider document ids and appends `PENDING`. A verified sandbox webhook moves the case to `UNDER_REVIEW` and appends a `human_review_cases` row with subject `KYC`. That is the same queue Module 09 uses for payouts.

`VERIFIED` and `REJECTED` are final and require the existing `ADMIN` role. The stored actor is `SUPER_ADMIN`. Reject requires a non-empty reason. The API returns the status only.

## Startup

Unset `KYC_PROVIDER` is the sandbox. `KYC_PROVIDER=live` does not start, because no real provider is configured.

## Payout gate

Module 09 already rejects a payout with `KYC_REQUIRED` unless the latest KYC event is `VERIFIED`. This module does not rewrite that check. Requiring KYC before a payout is provisional and still awaiting the founder.
