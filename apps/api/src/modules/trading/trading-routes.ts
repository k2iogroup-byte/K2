import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';

import { AppError } from '../../infrastructure/http/errors.js';
import { parseWithSchema } from '../../infrastructure/http/validation.js';
import type { AuthService } from '../auth/auth-service.js';
import { PERMISSIONS, requirePermission, requireVerifiedEmail } from '../auth/rbac.js';
import { noStore, requireRead, requireWrite, sendJson } from '../auth/request-context.js';
import { closeByPercent } from './close-position.js';
import { accountEquity, type EquityLeg } from './equity.js';
import type { Phase2Orders } from './phase2-orders.js';
import { orderActionAllowed } from './phase2-orders.js';
import {
  assertEntryProtection,
  attachFilledProtection,
  cancelEntryProtection,
  patchProtection,
  protectionHash,
  saveEntryProtection,
} from './protection.js';
import type { TradingFanout } from './trading-fanout.js';
import type { ExecutableQuote, TradingService } from './trading-service.js';
import { TradingConflictError, TradingNotFoundError } from './trading-service.js';

const orderBodySchema = z.strictObject({
  accountId: z.uuid(),
  instrumentId: z.uuid(),
  clientOrderId: z.string().min(1).max(64),
  side: z.enum(['BUY', 'SELL']),
  orderType: z.enum(['MARKET', 'LIMIT', 'STOP']),
  quantity: z.string().min(1).max(32),
  limitPrice: z.string().min(1).max(32).nullable(),
  stopLossPrice: z.string().min(1).max(32).nullable().optional(),
  takeProfitPrice: z.string().min(1).max(32).nullable().optional(),
});

const protectionBodySchema = z.strictObject({
  version: z.number().int().nonnegative(),
  stopLossPrice: z.string().min(1).max(32).nullable(),
  takeProfitPrice: z.string().min(1).max(32).nullable(),
});

const closeBodySchema = z.strictObject({
  percentage: z.union([z.literal(25), z.literal(50), z.literal(75), z.literal(100)]),
});

const protectionResponseSchema = z.strictObject({
  positionId: z.uuid(),
  version: z.number().int(),
  stopLossPrice: z.string().nullable(),
  takeProfitPrice: z.string().nullable(),
});

const accountQuerySchema = z.strictObject({
  accountId: z.uuid(),
});

const orderResponseSchema = z.strictObject({
  orderId: z.uuid().nullable(),
  state: z.string(),
  rejectReason: z.string().nullable(),
  filledQuantity: z.string(),
  cash: z.string().nullable(),
  executionId: z.uuid().nullable(),
  executionVenue: z.literal('K2_SIMULATION'),
  liveMarketData: z.literal(false),
});

const orderListSchema = z.strictObject({
  orders: z.array(
    z.strictObject({
      orderId: z.uuid(),
      state: z.string(),
      side: z.string(),
      filledQuantity: z.string(),
      acceptSequence: z.string().regex(/^[0-9]+$/),
      rejectReason: z.string().nullable(),
    }),
  ),
});

const positionListSchema = z.strictObject({
  equity: z.string().nullable(),
  positions: z.array(
    z.strictObject({
      positionId: z.uuid(),
      instrumentId: z.uuid(),
      status: z.string(),
      quantity: z.string(),
      reservedSell: z.string(),
      stopLossPrice: z.string().nullable(),
      takeProfitPrice: z.string().nullable(),
      protectionVersion: z.number().int(),
    }),
  ),
});

const idParamsSchema = z.strictObject({ id: z.uuid() });

export function registerTradingRoutes(
  app: FastifyInstance,
  auth: AuthService,
  trading: TradingService,
  phase2: Phase2Orders,
  pool: Pool,
  fanout: TradingFanout,
): void {
  app.post('/trading/orders', async (request, reply) => {
    noStore(reply);
    const session = await requireWrite(auth, request);
    requireVerifiedEmail(session);
    requirePermission(session, PERMISSIONS.tradingExecute);
    const key = idempotencyKey(request.headers['idempotency-key']);
    const body = parseWithSchema(orderBodySchema, request.body);
    if (!orderActionAllowed(body.side, body.orderType)) {
      throw new AppError('VALIDATION_ERROR', 400, 'This side and order type are not allowed');
    }
    const quote = await loadQuote(pool, body.instrumentId);
    await rememberEntryProtection(pool, session.userId, key, body, quote);
    if (body.orderType === 'STOP') {
      if (!body.limitPrice) {
        throw new AppError('VALIDATION_ERROR', 400, 'A stop order needs a trigger price');
      }
      try {
        const placed = await phase2.placeStop({
          accountId: body.accountId,
          userId: session.userId,
          instrumentId: body.instrumentId,
          clientOrderId: body.clientOrderId,
          idempotencyKey: key,
          quantity: body.quantity,
          triggerPrice: body.limitPrice,
          quote,
        });
        if (placed.rejectReason) {
          await cancelEntryProtection(pool, body.accountId, body.clientOrderId);
        } else if (quote) {
          await phase2.onQuote(body.instrumentId, quote);
          await attachFilledProtection(pool, body.accountId, body.instrumentId);
        }
        const viewed = placed.orderId
          ? await phase2.readOrder(session.userId, placed.orderId)
          : null;
        fanout.publish(session.userId, { type: 'order', accountId: body.accountId });
        return await sendJson(reply, 200, orderResponseSchema, {
          ...(viewed ?? placed),
          executionVenue: 'K2_SIMULATION',
          liveMarketData: false,
        });
      } catch (error) {
        if (error instanceof TradingNotFoundError) {
          throw new AppError('NOT_FOUND', 404, 'Trading account not found');
        }
        if (error instanceof TradingConflictError) {
          throw new AppError('CONFLICT', 409, error.message);
        }
        throw error;
      }
    }
    if (quote) await phase2.onQuote(body.instrumentId, quote);
    if (
      body.side === 'BUY' &&
      (await phase2.nativeBuyBlocked(body.accountId, session.userId, body.instrumentId))
    ) {
      await cancelEntryProtection(pool, body.accountId, body.clientOrderId);
      fanout.publish(session.userId, { type: 'order', accountId: body.accountId });
      return await sendJson(reply, 200, orderResponseSchema, {
        orderId: null,
        state: 'REJECTED',
        rejectReason: 'POSITION_ALREADY_OPEN',
        filledQuantity: '0.00000000',
        cash: null,
        executionId: null,
        executionVenue: 'K2_SIMULATION',
        liveMarketData: false,
      });
    }
    try {
      const result = await trading.submit({
        accountId: body.accountId,
        userId: session.userId,
        instrumentId: body.instrumentId,
        clientOrderId: body.clientOrderId,
        idempotencyKey: key,
        side: body.side,
        orderType: body.orderType,
        quantity: body.quantity,
        limitPrice: body.limitPrice,
        quote,
      });
      if (result.rejectReason) {
        await cancelEntryProtection(pool, body.accountId, body.clientOrderId);
      } else {
        await attachFilledProtection(pool, body.accountId, body.instrumentId);
        if (quote) await phase2.onQuote(body.instrumentId, quote);
      }
      fanout.publish(session.userId, { type: 'order', accountId: body.accountId });
      return await sendJson(reply, 200, orderResponseSchema, {
        ...result,
        executionVenue: 'K2_SIMULATION',
        liveMarketData: false,
      });
    } catch (error) {
      if (error instanceof TradingNotFoundError) {
        throw new AppError('NOT_FOUND', 404, 'Trading account not found');
      }
      if (error instanceof TradingConflictError) {
        throw new AppError('CONFLICT', 409, error.message);
      }
      throw error;
    }
  });

  app.get('/trading/orders/:id', async (request, reply) => {
    noStore(reply);
    const session = await requireRead(auth, request);
    requireVerifiedEmail(session);
    requirePermission(session, PERMISSIONS.tradingRead);
    const params = parseWithSchema(idParamsSchema, request.params);
    const order = await phase2.readOrder(session.userId, params.id);
    if (!order) throw new AppError('NOT_FOUND', 404, 'Order not found');
    return sendJson(reply, 200, orderResponseSchema, {
      ...order,
      executionVenue: 'K2_SIMULATION',
      liveMarketData: false,
    });
  });

  app.get('/trading/orders', async (request, reply) => {
    noStore(reply);
    const session = await requireRead(auth, request, accountQuerySchema);
    requireVerifiedEmail(session);
    requirePermission(session, PERMISSIONS.tradingRead);
    const query = parseWithSchema(accountQuerySchema, request.query);
    await assertOwnAccount(pool, session.userId, query.accountId);
    const rows = await pool.query<{
      id: string;
      state: string;
      side: string;
      filled_quantity: string;
      accept_sequence: string;
      reject_reason: string | null;
    }>(
      `SELECT id, state, side, filled_quantity::text, accept_sequence::text, reject_reason
       FROM orders WHERE account_id = $1 AND user_id = $2
       ORDER BY accept_sequence`,
      [query.accountId, session.userId],
    );
    return sendJson(reply, 200, orderListSchema, {
      orders: rows.rows.map((row) => ({
        orderId: row.id,
        state: row.state,
        side: row.side,
        filledQuantity: row.filled_quantity,
        acceptSequence: row.accept_sequence,
        rejectReason: row.reject_reason,
      })),
    });
  });

  app.get('/trading/positions', async (request, reply) => {
    noStore(reply);
    const session = await requireRead(auth, request, accountQuerySchema);
    requireVerifiedEmail(session);
    requirePermission(session, PERMISSIONS.tradingRead);
    const query = parseWithSchema(accountQuerySchema, request.query);
    await assertOwnAccount(pool, session.userId, query.accountId);
    const rows = await pool.query<{
      id: string;
      instrument_id: string;
      status: string;
      quantity: string;
      reserved_sell: string;
      stop_loss_price: string | null;
      take_profit_price: string | null;
      protection_version: string | null;
    }>(
      `SELECT positions.id, positions.instrument_id, positions.status,
              positions.quantity::text, positions.reserved_sell::text,
              position_protection.stop_loss_price::text,
              position_protection.take_profit_price::text,
              position_protection.version::text AS protection_version
       FROM positions
       JOIN trading_accounts ON trading_accounts.id = positions.account_id
       LEFT JOIN position_protection ON position_protection.position_id = positions.id
       WHERE positions.account_id = $1 AND trading_accounts.user_id = $2`,
      [query.accountId, session.userId],
    );
    return sendJson(reply, 200, positionListSchema, {
      equity: await listedEquity(pool, query.accountId),
      positions: rows.rows.map((row) => ({
        positionId: row.id,
        instrumentId: row.instrument_id,
        status: row.status,
        quantity: row.quantity,
        reservedSell: row.reserved_sell,
        stopLossPrice: row.stop_loss_price,
        takeProfitPrice: row.take_profit_price,
        protectionVersion: row.protection_version === null ? 0 : Number(row.protection_version),
      })),
    });
  });

  app.patch('/trading/positions/:id', async (request, reply) => {
    noStore(reply);
    const session = await requireWrite(auth, request);
    requireVerifiedEmail(session);
    requirePermission(session, PERMISSIONS.tradingExecute);
    const key = idempotencyKey(request.headers['idempotency-key']);
    const params = parseWithSchema(idParamsSchema, request.params);
    const body = parseWithSchema(protectionBodySchema, request.body);
    try {
      const saved = await patchProtection(pool, {
        positionId: params.id,
        userId: session.userId,
        version: body.version,
        stopLoss: body.stopLossPrice,
        takeProfit: body.takeProfitPrice,
        idempotencyKey: key,
        requestHash: protectionHash(body),
      });
      await publishAccount(pool, fanout, session.userId, params.id, 'protection');
      return await sendJson(reply, 200, protectionResponseSchema, saved);
    } catch (error) {
      if (error instanceof TradingConflictError) {
        throw new AppError('CONFLICT', 409, error.message);
      }
      throw error;
    }
  });

  app.post('/trading/positions/:id/close', async (request, reply) => {
    noStore(reply);
    const session = await requireWrite(auth, request);
    requireVerifiedEmail(session);
    requirePermission(session, PERMISSIONS.tradingExecute);
    const key = idempotencyKey(request.headers['idempotency-key']);
    const params = parseWithSchema(idParamsSchema, request.params);
    const body = parseWithSchema(closeBodySchema, request.body);
    const quote = await loadQuoteForPosition(pool, params.id);
    try {
      const result = await closeByPercent(pool, trading, {
        positionId: params.id,
        userId: session.userId,
        percentage: body.percentage,
        idempotencyKey: key,
        requestHash: protectionHash({ positionId: params.id, percentage: body.percentage }),
        quote,
      });
      await publishAccount(pool, fanout, session.userId, params.id, 'position');
      await publishAccount(
        pool,
        fanout,
        session.userId,
        params.id,
        result.state === 'FILLED' ? 'fill' : 'order',
      );
      return await sendJson(reply, 200, orderResponseSchema, {
        ...result,
        executionVenue: 'K2_SIMULATION',
        liveMarketData: false,
      });
    } catch (error) {
      if (error instanceof TradingConflictError) {
        throw new AppError('CONFLICT', 409, error.message);
      }
      throw error;
    }
  });
}

async function rememberEntryProtection(
  pool: Pool,
  userId: string,
  key: string,
  body: {
    accountId: string;
    instrumentId: string;
    clientOrderId: string;
    side: 'BUY' | 'SELL';
    orderType: 'MARKET' | 'LIMIT' | 'STOP';
    limitPrice: string | null;
    stopLossPrice?: string | null;
    takeProfitPrice?: string | null;
  },
  quote: ExecutableQuote | null,
): Promise<void> {
  const stop = body.stopLossPrice ?? null;
  const take = body.takeProfitPrice ?? null;
  if (!stop && !take) return;
  if (body.side !== 'BUY') {
    throw new AppError('VALIDATION_ERROR', 400, 'Protection belongs on an entry buy');
  }
  const reference = body.orderType === 'MARKET' ? (quote?.ask ?? null) : body.limitPrice;
  if (!reference) {
    throw new AppError('VALIDATION_ERROR', 400, 'A quote is required to check protection prices');
  }
  await assertEntryProtection(pool, body.instrumentId, stop, take, reference);
  const seen = await pool.query('SELECT 1 FROM trading_commands WHERE idempotency_key = $1', [key]);
  if ((seen.rowCount ?? 0) > 0) return;
  await saveEntryProtection(pool, {
    accountId: body.accountId,
    userId,
    instrumentId: body.instrumentId,
    clientOrderId: body.clientOrderId,
    stopLoss: stop,
    takeProfit: take,
  });
}

async function publishAccount(
  pool: Pool,
  fanout: TradingFanout,
  userId: string,
  positionId: string,
  type: 'position' | 'protection' | 'order' | 'fill',
): Promise<void> {
  const row = await pool.query<{ account_id: string }>(
    'SELECT account_id FROM positions WHERE id = $1',
    [positionId],
  );
  const accountId = row.rows[0]?.account_id;
  if (!accountId) return;
  fanout.publish(userId, { type, accountId });
}

function idempotencyKey(value: string | string[] | undefined): string {
  const key = Array.isArray(value) ? value[0] : value;
  if (!key || key.trim().length < 8 || key.length > 200) {
    throw new AppError('VALIDATION_ERROR', 400, 'Idempotency-Key is required');
  }
  return key.trim();
}

async function assertOwnAccount(pool: Pool, userId: string, accountId: string): Promise<void> {
  const owned = await pool.query('SELECT 1 FROM trading_accounts WHERE id = $1 AND user_id = $2', [
    accountId,
    userId,
  ]);
  if ((owned.rowCount ?? 0) === 0) {
    throw new AppError('NOT_FOUND', 404, 'Trading account not found');
  }
}

async function loadQuoteForPosition(
  pool: Pool,
  positionId: string,
): Promise<ExecutableQuote | null> {
  const row = await pool.query<{ instrument_id: string }>(
    'SELECT instrument_id FROM positions WHERE id = $1',
    [positionId],
  );
  const instrumentId = row.rows[0]?.instrument_id;
  if (!instrumentId) return null;
  return loadQuote(pool, instrumentId);
}

async function loadQuote(pool: Pool, instrumentId: string): Promise<ExecutableQuote | null> {
  const row = await pool.query<{
    bid: string;
    ask: string;
    bid_size: string;
    ask_size: string;
    received_timestamp: Date;
    feed_state: ExecutableQuote['feedState'];
    price_origin: ExecutableQuote['priceOrigin'];
    provider_event_id: string;
    sequence_no: string;
  }>(
    `SELECT bid::text, ask::text, bid_size::text, ask_size::text, received_timestamp,
            feed_state, price_origin, provider_event_id, sequence_no::text
     FROM quote_snapshots WHERE instrument_id = $1`,
    [instrumentId],
  );
  const quote = row.rows[0];
  if (!quote) return null;
  const updateId = /^[0-9]+$/.test(quote.provider_event_id)
    ? quote.provider_event_id
    : quote.sequence_no;
  return {
    quoteUpdateId: updateId,
    bid: quote.bid,
    ask: quote.ask,
    bidSize: quote.bid_size,
    askSize: quote.ask_size,
    receivedAt: quote.received_timestamp,
    feedState: quote.feed_state,
    priceOrigin: quote.price_origin,
  };
}

async function listedEquity(pool: Pool, accountId: string): Promise<string | null> {
  const cash = await pool.query<{ cash: string }>(
    'SELECT cash::text FROM simulation_cash_projections WHERE account_id = $1',
    [accountId],
  );
  const cashText = cash.rows[0]?.cash;
  if (!cashText) return null;
  const legs = await pool.query<{
    quantity: string;
    quantity_scale: number;
    price_scale: number;
    quote_asset: string | null;
    bid: string | null;
  }>(
    `SELECT positions.quantity::text, instruments.quantity_scale, instruments.price_scale,
            instruments.quote_asset, quote_snapshots.bid::text AS bid
       FROM positions
       JOIN instruments ON instruments.id = positions.instrument_id
       LEFT JOIN quote_snapshots ON quote_snapshots.instrument_id = positions.instrument_id
      WHERE positions.account_id = $1 AND positions.status = 'OPEN' AND positions.quantity > 0`,
    [accountId],
  );
  const valued: EquityLeg[] = [];
  for (const leg of legs.rows) {
    if (!leg.bid || !leg.quote_asset) return null;
    valued.push({
      quantity: leg.quantity,
      quantityScale: leg.quantity_scale,
      bid: leg.bid,
      priceScale: leg.price_scale,
      quoteAsset: leg.quote_asset,
    });
  }
  return accountEquity(cashText, valued);
}
