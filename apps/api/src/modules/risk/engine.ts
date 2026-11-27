import { randomUUID } from 'node:crypto';

import { DecimalError, decimalGreaterThan } from '@k2/shared';
import type { PoolClient } from 'pg';

import { accountEquity, type EquityLeg } from '../trading/equity.js';
import {
  type RiskAuthorizationRequest,
  type RiskAuthorizer,
  type RiskDecision,
} from '../trading/risk-authorizer.js';
import { quotePriceToUsd, settlesAsUsd } from '../trading/usdt-usd.js';
import {
  dailyLossFloor,
  drawdownFloor,
  higherPrice,
  stressedBreaches,
  type StressedBuy,
  stressedEquity,
} from './limits.js';

const MONEY = 4;

/**
 * Pre-trade check. The caller already holds trading_accounts FOR UPDATE.
 * Pending buys are assumed filled. Pending sells are ignored.
 * Missing prices reject. They are not treated as a breach.
 */
export class RiskEngineAuthorizer implements RiskAuthorizer {
  authorize(request: RiskAuthorizationRequest, client?: PoolClient): Promise<RiskDecision> {
    if (!client) return Promise.resolve(unavailable());
    return evaluatePretrade(client, request);
  }
}

export async function evaluatePretrade(
  client: PoolClient,
  request: RiskAuthorizationRequest,
): Promise<RiskDecision> {
  const account = await client.query<{ initial_capital: string }>(
    `SELECT initial_capital::text FROM trading_accounts WHERE id = $1 FOR UPDATE`,
    [request.accountId],
  );
  const initial = account.rows[0]?.initial_capital;
  if (!initial) return unavailable();

  const equity = await readAccountEquity(client, request.accountId);
  if (!equity)
    return record(client, request.accountId, 'REJECT', 'TEMPORARILY_UNAVAILABLE', null, null, null);

  const high = await rememberEquityHigh(client, request.accountId, equity);
  const daily = dailyLossFloor(high);
  const drawdown = drawdownFloor(initial);
  const buys = await pendingBuys(client, request);
  if (!buys)
    return record(
      client,
      request.accountId,
      'REJECT',
      'TEMPORARILY_UNAVAILABLE',
      equity,
      daily,
      drawdown,
    );

  const stressed = stressedEquity(equity, buys);
  const reason = breachReason(stressed, daily, drawdown);
  if (reason) return record(client, request.accountId, 'REJECT', reason, equity, daily, drawdown);
  return record(client, request.accountId, 'APPROVE', 'RISK_OK', equity, daily, drawdown);
}

/** Cash plus open longs at the bid. Null when a mark is missing. */
export async function readAccountEquity(
  client: PoolClient,
  accountId: string,
  overlay?: { instrumentId: string; bid: string },
): Promise<string | null> {
  const cash = await client.query<{ cash: string | null; initial_capital: string }>(
    `SELECT projections.cash::text AS cash, accounts.initial_capital::text AS initial_capital
     FROM trading_accounts AS accounts
     LEFT JOIN simulation_cash_projections AS projections ON projections.account_id = accounts.id
     WHERE accounts.id = $1`,
    [accountId],
  );
  const row = cash.rows[0];
  if (!row) return null;
  const legs = await client.query<{
    instrument_id: string;
    quantity: string;
    quantity_scale: number;
    price_scale: number;
    quote_asset: string | null;
    bid: string | null;
  }>(
    `SELECT positions.instrument_id, positions.quantity::text AS quantity,
            instruments.quantity_scale, instruments.price_scale,
            instruments.quote_asset, snapshots.bid::text AS bid
     FROM positions
     JOIN instruments ON instruments.id = positions.instrument_id
     LEFT JOIN quote_snapshots AS snapshots ON snapshots.instrument_id = positions.instrument_id
     WHERE positions.account_id = $1 AND positions.status = 'OPEN' AND positions.quantity > 0`,
    [accountId],
  );
  const equityLegs: EquityLeg[] = [];
  for (const leg of legs.rows) {
    const bid = overlay?.instrumentId === leg.instrument_id ? overlay.bid : leg.bid;
    if (!bid || !leg.quote_asset) return null;
    equityLegs.push({
      quantity: leg.quantity,
      quantityScale: leg.quantity_scale,
      bid,
      priceScale: leg.price_scale,
      quoteAsset: leg.quote_asset,
    });
  }
  return accountEquity(row.cash ?? row.initial_capital, equityLegs);
}

/** Insert EQUITY_HIGH only when this equity is a strict new high for the UTC day. */
export async function rememberEquityHigh(
  client: PoolClient,
  accountId: string,
  equity: string,
): Promise<string> {
  await client.query(
    `INSERT INTO risk_day_marks (account_id, utc_date, kind, mark)
     SELECT $1, (transaction_timestamp() AT TIME ZONE 'UTC')::date, 'EQUITY_HIGH', $2::numeric
     WHERE NOT EXISTS (
       SELECT 1 FROM risk_day_marks
       WHERE account_id = $1
         AND utc_date = (transaction_timestamp() AT TIME ZONE 'UTC')::date
         AND kind = 'EQUITY_HIGH'
         AND mark >= $2::numeric
     )`,
    [accountId, equity],
  );
  const stored = await client.query<{ mark: string }>(
    `SELECT max(mark)::text AS mark
     FROM risk_day_marks
     WHERE account_id = $1
       AND utc_date = (transaction_timestamp() AT TIME ZONE 'UTC')::date
       AND kind = 'EQUITY_HIGH'`,
    [accountId],
  );
  const mark = stored.rows[0]?.mark;
  if (!mark) throw new Error('equity high was not recorded');
  return mark;
}

type PriceRow = {
  quantity: string;
  quantity_scale: number;
  price_scale: number;
  quote_asset: string | null;
  bid: string | null;
  ask: string | null;
  limit_price: string | null;
  trigger_price: string | null;
  order_type: string;
};

async function pendingBuys(
  client: PoolClient,
  request: RiskAuthorizationRequest,
): Promise<StressedBuy[] | null> {
  const working = await client.query<PriceRow>(
    `SELECT (orders.quantity - orders.filled_quantity)::text AS quantity,
            instruments.quantity_scale, instruments.price_scale, instruments.quote_asset,
            snapshots.bid::text AS bid, snapshots.ask::text AS ask,
            orders.limit_price::text AS limit_price, NULL::text AS trigger_price, orders.order_type
     FROM orders
     JOIN instruments ON instruments.id = orders.instrument_id
     LEFT JOIN quote_snapshots AS snapshots ON snapshots.instrument_id = orders.instrument_id
     WHERE orders.account_id = $1 AND orders.side = 'BUY'
       AND orders.state IN ('OPEN', 'PARTIALLY_FILLED')`,
    [request.accountId],
  );
  const stops = await client.query<PriceRow>(
    `SELECT conditional_orders.quantity::text AS quantity,
            instruments.quantity_scale, instruments.price_scale, instruments.quote_asset,
            snapshots.bid::text AS bid, snapshots.ask::text AS ask,
            NULL::text AS limit_price, conditional_orders.trigger_price::text AS trigger_price,
            'ENTRY_STOP' AS order_type
     FROM conditional_orders
     JOIN instruments ON instruments.id = conditional_orders.instrument_id
     LEFT JOIN quote_snapshots AS snapshots ON snapshots.instrument_id = conditional_orders.instrument_id
     WHERE conditional_orders.account_id = $1 AND conditional_orders.kind = 'ENTRY_STOP'
       AND conditional_orders.side = 'BUY' AND conditional_orders.state = 'PENDING'`,
    [request.accountId],
  );
  const buys: StressedBuy[] = [];
  for (const row of [...working.rows, ...stops.rows]) {
    try {
      if (!decimalGreaterThan(row.quantity, '0', row.quantity_scale)) continue;
    } catch (error) {
      if (error instanceof DecimalError) return null;
      throw error;
    }
    const buy = stressRow(row);
    if (!buy) return null;
    buys.push(buy);
  }
  if (request.side === 'BUY') {
    const incoming = await incomingBuy(client, request);
    if (!incoming) return null;
    buys.push(incoming);
  }
  return buys;
}

async function incomingBuy(
  client: PoolClient,
  request: RiskAuthorizationRequest,
): Promise<StressedBuy | null> {
  const instrument = await client.query<{
    quantity_scale: number;
    price_scale: number;
    quote_asset: string | null;
  }>(`SELECT quantity_scale, price_scale, quote_asset FROM instruments WHERE id = $1`, [
    request.instrumentId,
  ]);
  const row = instrument.rows[0];
  if (!row || !request.orderType) return null;
  return stressRow({
    quantity: request.quantity,
    quantity_scale: row.quantity_scale,
    price_scale: row.price_scale,
    quote_asset: row.quote_asset,
    bid: request.bid ?? null,
    ask: request.ask ?? null,
    limit_price: request.limitPrice ?? null,
    trigger_price: null,
    order_type: request.orderType,
  });
}

function stressRow(row: PriceRow): StressedBuy | null {
  if (!row.quote_asset || !settlesAsUsd(row.quote_asset) || !row.bid) return null;
  try {
    const mark = quotePriceToUsd(row.quote_asset, row.bid, row.price_scale);
    const fill = fillPrice(row);
    if (!fill) return null;
    if (!decimalGreaterThan(row.quantity, '0', row.quantity_scale)) return null;
    return {
      quantity: row.quantity,
      quantityScale: row.quantity_scale,
      fillPrice: fill,
      mark,
      priceScale: row.price_scale,
    };
  } catch (error) {
    if (error instanceof DecimalError) return null;
    throw error;
  }
}

function fillPrice(row: PriceRow): string | null {
  if (!row.quote_asset) return null;
  if (row.order_type === 'LIMIT') {
    if (!row.limit_price) return null;
    return quotePriceToUsd(row.quote_asset, row.limit_price, row.price_scale);
  }
  if (row.order_type === 'MARKET') {
    if (!row.ask) return null;
    return quotePriceToUsd(row.quote_asset, row.ask, row.price_scale);
  }
  if (row.order_type === 'ENTRY_STOP') {
    if (!row.ask || !row.trigger_price) return null;
    const ask = quotePriceToUsd(row.quote_asset, row.ask, row.price_scale);
    const stop = quotePriceToUsd(row.quote_asset, row.trigger_price, row.price_scale);
    return higherPrice(stop, ask, row.price_scale);
  }
  return null;
}

function breachReason(
  equity: string,
  daily: string,
  drawdown: string,
): 'DAILY_LOSS' | 'MAX_DRAWDOWN' | null {
  const dailyHit = stressedBreaches(equity, daily);
  const drawdownHit = stressedBreaches(equity, drawdown);
  if (!dailyHit && !drawdownHit) return null;
  if (dailyHit && drawdownHit) {
    return decimalGreaterThan(daily, drawdown, MONEY) ? 'DAILY_LOSS' : 'MAX_DRAWDOWN';
  }
  return dailyHit ? 'DAILY_LOSS' : 'MAX_DRAWDOWN';
}

async function record(
  client: PoolClient,
  accountId: string,
  decision: 'APPROVE' | 'REJECT',
  reasonCode: string,
  equity: string | null,
  daily: string | null,
  drawdown: string | null,
): Promise<RiskDecision> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO risk_decisions (
       account_id, kind, decision, reason_code, equity, daily_floor, drawdown_floor
     ) VALUES ($1, 'PRETRADE', $2, $3, $4, $5, $6)
     RETURNING id`,
    [accountId, decision, reasonCode, equity, daily, drawdown],
  );
  const id = inserted.rows[0]?.id ?? randomUUID();
  return {
    decision,
    decisionId: id,
    reasonCode,
    mode: reasonCode === 'TEMPORARILY_UNAVAILABLE' ? 'FAIL_CLOSED' : 'RISK_ENGINE',
  };
}

function unavailable(): RiskDecision {
  return {
    decision: 'REJECT',
    decisionId: randomUUID(),
    reasonCode: 'TEMPORARILY_UNAVAILABLE',
    mode: 'FAIL_CLOSED',
  };
}
