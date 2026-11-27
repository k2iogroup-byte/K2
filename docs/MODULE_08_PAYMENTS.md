# Module 08 — Payments

**Status:** Contract 2026-11-27. No real payment provider is selected. The only implementation is a sandbox. No card data is stored. No refund is implemented.

## Provider

`PaymentProvider` has `createCharge`, `verifyWebhook`, and `refund`. `refund` is on the interface and throws until a founder allows refunds. `PAYMENT_PROVIDER=sandbox` uses the sandbox. `PAYMENT_PROVIDER=live` refuses to start, because no live provider is connected. Unset means sandbox so existing development and staging configuration still boots.

The sandbox moves no money. A webhook signature is HMAC-SHA256 of the raw body with the sandbox test key. A bad signature is rejected. The same provider event id is stored once (`UNIQUE`).

## Challenge purchase

The price is read from the pinned `product_price_versions` row. Module 08 does not invent a price. `rule_set_versions` has no price column. A succeeded webhook builds the verified-purchase evidence Module 03 already accepts and calls `provisionFromVerifiedPurchase`. The account becomes `PROVISIONED`. Module 03's internal rules are unchanged.

## Subscription billing

Due rows come from `subscription_charges`. A sandbox success appends `subscription_receipts`. It does not change `trading_accounts.state`.

A sandbox failure does not set `FAILED` or `PAUSED`. If `SUBSCRIPTION_GRACE_DAYS` is set, a grace row records the deadline. When that time is reached, an append-only `human_review_items` row is written with subject `PAYMENT_GRACE_EXPIRY`. If the variable is unset, there is no guessed number of days: the review row is written immediately. That is provisional.

## Actor

Payment and review rows store `actor_type`. Module 08 writes `SYSTEM`.
