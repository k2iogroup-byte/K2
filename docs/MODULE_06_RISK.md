# Module 06 — Risk engine

**Status:** Implemented on 2026-11-27 for the Challenge simulation. Not deployed. Production fills stay off. The server process still constructs `FailClosedRiskAuthorizer`, so an API buy is still rejected. Tests inject `RiskEngineAuthorizer`. There is no broker, no real money, and no Redis, Kafka, or new service.

## Equity

One function, `accountEquity`, prices an account. Cash is the simulation cash projection, or the initial balance when that projection does not exist yet. An open long is quantity times the bid. USD is used as-is. USDT is 1:1. A missing bid or an unusable quote asset makes equity null. The engine then rejects the buy as `TEMPORARILY_UNAVAILABLE`. It does not invent a price and it does not call that a breach.

`GET /trading/positions` returns that same equity for the account.

## Floors

The daily floor is 0.95 times the highest equity of the UTC day. `risk_day_marks` stores `EQUITY_HIGH` only when the equity is a strict new high. The first evaluation after 00:00 UTC writes the day-open mark, including when the account is flat. That mark does not depend on the stage timer.

There is no tick filter. Equity is money at scale 4. A minimum tick would skip a real high on a small position. One new high is one row per account per day, not one row per quote.

The drawdown floor is 0.92 times the initial balance and does not rise. Touching either floor is a breach: equity less than or equal to the floor.

Worked values for a $100,000 account:

| Event                                           | Result                 |
| ----------------------------------------------- | ---------------------- |
| Equity high $105,000.00, cash still $100,000.00 | Daily floor $99,750.00 |
| Equity $92,000.00                               | Drawdown breach        |

M06 does not recompute the 0.5 percent opening fee. It reads cash after the trading engine has already reduced it.

## Pre-trade

A new buy is checked in the same database transaction as the account row lock. Every working buy is assumed filled: an open or partially filled buy at its remaining quantity, and a pending entry-stop buy. A limit is priced at its limit. A market buy is priced at the ask. An entry stop is priced at the higher of the stop and the ask. The mark stays the bid. The opening fee is the same 0.5 percent the trading engine charges.

Pending sells, closes, stop-losses, and take-profits are not counted. They would free room.

If the stressed equity is less than or equal to either floor, the buy is rejected with `DAILY_LOSS` or `MAX_DRAWDOWN`. Two buys that each fit, but not together, cannot both pass: the second waits on the account lock and sees the first order. The decision is stored in `risk_decisions` in that same transaction.

## Breach

After protection fires on a quote, and again after a fill, the engine recomputes equity for the affected account. A breach inserts one `risk_breaches` row (`UNIQUE(account_id)`), writes a `FAILED` state transition, and sells the free quantity with a market order through the risk-reducing path. The sell fills at the bid even when the equity calendar is closed or the feed is stale.

If the sell cannot fill, the account stays `FAILED`. `risk_close_attempts` keeps the attempt, and a later quote retries it. A resolution row is written only when the sell fills. If a deferred close already reserved the quantity, the engine does not sell again. It links the attempt to that order.

A timeout uses this same close.

## Stage result

The profit target uses closed balance, not equity. Stage 1 is 8 percent and 30 calendar days from the first execution. Stage 2 is 5 percent and 60 calendar days. The current schema only allows `STAGE_1`, so the Stage 2 numbers are in the function and are not applied to a second account.

A pass also needs at least 7 trading days and no open position. A trading day is a UTC day with at least one execution. The pass writes `PASSED` and one `risk_stage_outcomes` row (`UNIQUE(account_id)`). Calling it again does not write a second row and does not create an account. Creating the Stage 2 or Funded account belongs to a later module.

A timeout without the target writes `FAILED`, a `TIMEOUT` breach, and force-closes open positions. The in-process review runs only on the replica that holds the trading lock. The day-open equity mark does not depend on that timer.

## Records

Migration `0013` adds append-only tables: `risk_decisions`, `risk_day_marks`, `risk_breaches`, `risk_close_attempts`, `risk_close_resolutions`, `risk_trading_days`, and `risk_stage_outcomes`. It does not alter `trading_accounts` or `purchase_evidence`. Money stays decimal. Prices, fees, and floors are not JavaScript floats.

## Out of scope

Hedging, copy-trading detection, news-trading limits, scaling in, payouts, shorts, futures, and options. The server authorizer stays fail-closed until a later switch. Real Account daily-loss value remains unresolved.
