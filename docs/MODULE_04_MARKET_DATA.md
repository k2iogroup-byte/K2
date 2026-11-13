# Module 04 — Market data infrastructure

**Status:** Corrected on `cursor/correction-modules-02-04-82a0`. Not deployed. No vendor account, API key, or live market connection is configured.

## Correction — 2026-11-14

Quotes, bars, and `/ws/market-data` require a verified email in addition to `market_data.read`. Feed health stays on `/internal/market-data/health` for staff with MFA and `market_data.health`.

Bar aggregation is covered for `1m`, `5m`, `15m`, `1h`, `4h`, and `1d`: UTC bucket alignment, OHLCV, duplicate event ids, out-of-order trades, missing minutes (no invented bars), and non-positive price or volume. `1d` buckets start at 00:00 UTC. Exchange session calendars and holidays are not implemented.

A WebSocket subscriber is removed on close, including when authentication finishes after the socket has already closed. A subscriber whose buffer exceeds 1 MiB is disconnected. Recent provider event ids are capped at 4,096 per instrument. Sequence checks still reject an older event after that cap.

The unit suite sends 5,000 quotes to 4 in-process consumers and 1,000 quotes to 32 in-process consumers. Both assert ordered delivery, zero live-data claims, and heap growth under 80 MB. That is not a test of 10,000 concurrent traders. No WebSocket load of 10,000 sessions was run. Capacity for that population is not claimed.

This file is the implemented contract. The proposed market-data rows in [API_SPECIFICATION.md](./API_SPECIFICATION.md) and [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) stay proposed.

## Scope

The engine accepts events from a provider adapter, normalises them, checks order and freshness, keeps the latest quote and aggregated bars, and fans the result out to in-process consumers. The only adapter in this build is a test fixture. Its prices are labeled `TEST_FIXTURE` and `liveMarketData: false`.

Supported venues are NYSE, NASDAQ, and Binance Spot. Forex, futures, and options are rejected.

## Flow

```text
Provider adapter
  → normalisation
  → validation and timestamps
  → in-process distribution
  → HTTP, WebSocket, and PostgreSQL snapshot/bar storage
```

The adapter interface is `MarketDataProvider`. `createProvider` accepts `disconnected` or `test-fixture`. Any other mode is rejected at startup. `test-fixture` is rejected outside development. The fixture provider does not open a socket.

## Feed state

| State          | Meaning                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| `LIVE`         | The source is connected and the latest accepted event is inside the freshness window.                  |
| `DEGRADED`     | Connected, but an event was invalid or out of order, or a fresh event has not arrived since reconnect. |
| `STALE`        | Accepted data is older than the freshness window.                                                      |
| `DISCONNECTED` | The adapter reported a disconnect, or no adapter is connected.                                         |

`liveMarketData` is true only when the origin is `VENDOR` and the state is `LIVE`. This build never selects `VENDOR`, so the flag stays false. A stale or disconnected feed is not reported as healthy. A `LIVE` fixture feed means the test source is fresh. The detail text says the prices are not live market data.

Freshness windows are engineering defaults, not exchange rules: 5 seconds for crypto and 30 seconds for equities, measured from the receive timestamp. Session calendars and holidays are not implemented.

## Timestamps and bars

Every accepted quote stores source time, receive time, and processing time in UTC. Invalid prices, crossed quotes, unknown symbols, backwards sequences, and backwards source times are not applied. A repeated provider event id is ignored. A forward sequence gap is reported to consumers and does not invent the missing events.

Bars are built only from trades, for `1m`, `5m`, `15m`, `1h`, `4h`, and `1d`, aligned to UTC. Quotes do not create bars. `GET /market-data/bars` reads stored bars and does not call a vendor.

## Retention

Raw ticks are not stored. `quote_snapshots` keeps one current row per instrument and replaces it. A later module that needs the quote used for a fill must copy that snapshot at decision time. Bars are kept per instrument, timeframe, and bucket. Feed-status changes are append-only. There is no purge job. At one-minute bars, a single instrument is about 525,000 rows per year per timeframe if every minute prints a trade. That is acceptable for the initial instrument set and should be revisited before a large symbol universe is loaded.

## Distribution

Consumers subscribe inside the API process. One provider connection feeds every subscriber. The WebSocket route `/ws/market-data` requires a session with `market_data.read`. The existing `/ws` ping route is unchanged.

Redis, Kafka, and a second service were not added. The API already owns the WebSocket connections, and the planning capacity is about 1,000 registered traders with a smaller concurrent set. An in-process fan-out meets that shape. A separate bus would be justified only after a measured limit, which this module does not claim to have reached. The volume test sends 5,000 quotes to four in-process consumers and checks order, duplicates, and that the heap growth stays under 80 MB. A second test sends 1,000 quotes to 32 consumers. Neither is a production capacity test of 10,000 traders.

## HTTP

| Method | Path                             | Access                                    |
| ------ | -------------------------------- | ----------------------------------------- |
| `GET`  | `/internal/market-data/health`   | Staff with MFA and `market_data.health`   |
| `GET`  | `/market-data/quotes/:symbol`    | Signed-in user with `market_data.read`    |
| `GET`  | `/market-data/bars`              | Signed-in user with `market_data.read`    |
| `POST` | `/staff/market-data/instruments` | `ADMIN` with MFA and `market_data.manage` |

`market_data.read` is granted to every role. `market_data.health` is granted to staff roles. `market_data.manage` is `ADMIN` only. That follows the Module 02 engineering default.

## Not available without approval

These items need a founder decision, a vendor contract, or both. They are not implemented.

| Need                                       | Why                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| US equities vendor and licence             | OQ-073. Display, non-display, per-user fees, and redistribution are unresolved.                        |
| Binance or another crypto source           | OQ-074. Public market data still needs a redistribution and geographic review before customers see it. |
| A second source per market                 | The architecture recommends one, and none is approved.                                                 |
| `VENDOR` origin and `liveMarketData: true` | No approved adapter exists, so the process cannot honestly say the prices are live.                    |
| Credential storage                         | No API key, secret, or header for a provider is read.                                                  |

## Files

Migration `apps/api/db/migrations/0004_market_data`. Engine, fixture provider, store, HTTP, and WebSocket under `apps/api/src/modules/market-data`. Shared contracts in `packages/shared/src/market-data.ts`.
