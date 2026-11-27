# Module 05 — Trading engine

**Status:** COMPLETE on 2026-11-27 for simulated trading. Not deployed. Production fills stay off. Live execution waits for Module 06.

The running server uses the Module 06 risk engine. `EXECUTION_ENABLED=true` is accepted only when `APP_ENV=development`. There is no broker and no real-money execution. A missing database client still fails closed. Equities with no exchange calendar still reject with `CALENDAR_UNCOVERED` before the engine runs.

## Completion — 2026-11-27

Simulated Module 05 now covers crypto and the earlier equity rules.

- Crypto settles 1 USDT as 1 USD. There is no float and no live FX conversion. Crypto buys do not use the equity session calendar. Equities with no calendar still reject with `CALENDAR_UNCOVERED`.
- The opening commission is 0.5 percent on crypto buys. Closing commission stays zero.
- Binance Spot `USDT` pairs are the crypto catalogue. There is no minimum-volume filter. Symbol status, base and quote assets, and the `PRICE_FILTER`, `LOT_SIZE`, and `NOTIONAL` or `MIN_NOTIONAL` values are stored in `instrument_exchange_filters`. Migrations stay additive.
- Tests sync a recorded `exchangeInfo`. A live `GET /api/v3/exchangeInfo` exists and sends no API key. CI does not call it.
- Crypto orders are checked against tick, step, minimum and maximum quantity, and minimum notional with integer decimal math.
- Public Binance Spot book tickers can be read from a WebSocket when `MARKET_DATA_MODE=binance-public`. Default, test, and CI modes do not open that socket. Subscriptions are on demand, at most 1024 streams on a connection and 5 outbound messages a second. The socket reconnects on drop and before the 24-hour disconnect. Quotes enter the same `onQuote` path as fixture quotes.
- One account has one open position per instrument. A second buy is `POSITION_ALREADY_OPEN`. Stop-loss and take-profit fire from `onQuote`. Closes of 25, 50, 75, and 100 percent are risk-reducing. A fresh quote fills at the bid. A stale quote waits for the next fresh bid. If the instrument has never had a quote, the close uses the average entry.
- A replica that is waiting for the trading lock is healthy for the deploy check and does not trade. A lost lock is not healthy. Readiness accepts applied migrations that include every migration this build knows, because migrations are additive.

Approved decisions A–N are unchanged. Scaling in stays rejected.

## Changelog — 2026-11-21

Phase 2 adds conditional orders and position protection on top of the existing order service. Migrations `0001` through `0007` are unchanged. Migration `0008` only adds `conditional_orders`, `position_protection`, and a trigger that rejects a new buy while a pending entry stop exists.

The running server authorizes buys with the Module 06 engine. Equities are still rejected with `CALENDAR_UNCOVERED` before that engine runs, because no exchange calendar is configured. Crypto reaches the engine. Fills stay off unless `APP_ENV=development` and `EXECUTION_ENABLED=true`.

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

`/ws/trading` keeps the market-data origin allowlist, payload cap, and connection limits, and also caps sockets per user. A missing session is closed. Events for one user are not written to another user's sockets. An accepted close that is waiting for a fresh price emits an order event, and the later fill emits a fill event.

## Phase 3 — 2026-11-21

A quote accepted by the market-data engine, from the fixture provider or the Binance public provider, is the same `onQuote` walk used when an order is submitted. There is one copy of the stop, stop-loss, and take-profit logic. It runs only while this process holds the singleton lock. After the lock is acquired, pending triggers are checked once against the latest stored snapshot. If several quotes arrive for one instrument before the walk finishes, only the newest is kept. Migration `0009` records the last update id. The cursor moves in the same transaction as the trigger state change, and that change matches the pending version, so a duplicate quote cannot fire twice.

A risk-reducing close is a close percentage, a stop-loss or take-profit, or a sell whose quantity does not exceed the open long. It skips the closed-calendar and stale-feed rejections and the fail-closed risk stub. The audit records `APPROVE` / `RISK_REDUCING`. Buys are unchanged and still fail closed.

| Situation                                                      | Result                                                                              | `price_basis`    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------- |
| Feed is fresh and the equity session is open                   | Fill now at the bid, using the shared book                                          | `FRESH`          |
| Feed is stale or disconnected, or the equity session is closed | Accept the close, reserve the quantity, fill the whole amount at the next fresh bid | `DEFERRED_FRESH` |
| No quote has ever been stored                                  | Fill now at the position average entry                                              | `ENTRY_FALLBACK` |

The waiting close is an `OPEN` order plus a row in `deferred_closes`. It is not cancelled and the client does not choose the price. A later sell or trigger cannot sell more than the quantity that is still free.
