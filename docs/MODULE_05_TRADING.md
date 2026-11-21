# Module 05 — Trading engine

**Status:** Phase 2 implemented on 2026-11-21. Not deployed. No live market data, no broker, and no approving risk authorizer.

## Changelog — 2026-11-21

Phase 2 adds conditional orders and position protection on top of the existing order service. Migrations `0001` through `0007` are unchanged. Migration `0008` only adds `conditional_orders`, `position_protection`, and a trigger that rejects a new buy while a pending entry stop exists.

The production risk authorizer still returns `REJECT` with `TEMPORARILY_UNAVAILABLE`. Equities are rejected with `CALENDAR_UNCOVERED` before that authorizer runs, because no exchange calendar is configured. Test doubles may approve inside integration tests. The server process does not.

Fills run only when `APP_ENV=development` and `EXECUTION_ENABLED=true`. `liveMarketData` stays false. Prices and profit are taken from the server quote, never from the client. The engine is long-only. There is no short, future, or option.

## Paths

The browser calls these through `/k2-api`. The API paths are:

| Method | Path                           | Result                                                                 |
| ------ | ------------------------------ | ---------------------------------------------------------------------- |
| POST   | `/trading/orders`              | Market, limit, or buy stop. Optional stop-loss and take-profit prices. |
| GET    | `/trading/orders`              | The caller's orders for one account.                                   |
| GET    | `/trading/orders/:id`          | One order. Another user's id is 404.                                   |
| GET    | `/trading/positions`           | Positions, including protection prices and version.                    |
| PATCH  | `/trading/positions/:id`       | Set, change, or clear protection. Requires the current version.        |
| POST   | `/trading/positions/:id/close` | Market sell of 25, 50, 75, or 100 percent.                             |
| GET    | `/ws/trading`                  | Order, fill, position, and protection events for the signed-in user.   |

Writes require a verified session, the trading execute permission, the CSRF and origin checks used by the other trading routes, and an `Idempotency-Key`. Replaying the same key and body returns the first response. A different body with the same key is 409.

## Orders

`BUY` with `MARKET` or `LIMIT` is unchanged. A buy limit fills when the ask is at or below the limit.

`STOP` is buy only. A sell stop is 400. The trigger price is `limitPrice`. The stop rests in `conditional_orders` until the ask is at or above the trigger, then the engine submits a market buy through the existing service. A gap fills at the actual ask, which can be worse than the stop.

A pending entry stop is a working entry. A new buy for that account and instrument is rejected with `POSITION_ALREADY_OPEN` while a position is open or a stop is pending.

## Protection

Stop-loss and take-profit on an entry must sit on either side of the reference price: the limit or stop price, or the current ask for a market order. On a later change, the stop must be below the current bid and the target above it. Otherwise the response is 400 `PROTECTION_PRICE_INVALID`.

When the position opens, the prices are stored in `position_protection` and stay on the remaining quantity after a partial close. A long stop-loss fires when the bid is at or below the stop. A take-profit fires when the bid is at or above the target. Either one sells the whole remaining quantity with a market order and cancels the other.

A manual close and a protection trigger share `reserved_sell`. The second sell fills only what is still free, or it is cancelled. It cannot sell more than the position.

## Close percentage

The body is `{ "percentage": 25 | 50 | 75 | 100 }`. Any other value is 400. The quantity is the free position quantity times the percentage, rounded down to the instrument quantity step. One hundred percent uses the exact free quantity, so no remainder is left by rounding. If the floored quantity is zero, the response is 400 and the position is unchanged.

## Socket

`/ws/trading` keeps the market-data origin allowlist, payload cap, and connection limits, and also caps sockets per user. A missing session is closed. Events for one user are not written to another user's sockets.
