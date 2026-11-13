import {
  BAR_TIMEFRAMES,
  barListResponseSchema,
  emptyQuerySchema,
  feedHealthSchema,
  instrumentRequestSchema,
  instrumentResponseSchema,
  quoteSnapshotSchema,
} from '@k2/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';

import { AppError } from '../../infrastructure/http/errors.js';
import { parseWithSchema } from '../../infrastructure/http/validation.js';
import type { AuthService } from '../auth/auth-service.js';
import { PERMISSIONS, requirePermission, requireStaffAccess } from '../auth/rbac.js';
import { noStore, requireRead, requireWrite, sendJson } from '../auth/request-context.js';
import type { MarketDataEngine } from './engine.js';
import { MarketDataStore } from './store.js';

const symbolParams = z.strictObject({
  symbol: z.string().regex(/^[A-Z0-9][A-Z0-9.-]{0,31}$/),
});
const barsQuerySchema = z.strictObject({
  symbol: z.string().regex(/^[A-Z0-9][A-Z0-9.-]{0,31}$/),
  timeframe: z.enum(BAR_TIMEFRAMES),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const engines = new WeakMap<FastifyInstance, MarketDataEngine>();

export function marketDataEngine(app: FastifyInstance): MarketDataEngine {
  const engine = engines.get(app);
  if (!engine) throw new Error('Market data engine is not registered');
  return engine;
}

export type MarketDataRouteOptions = {
  app: FastifyInstance;
  auth: AuthService;
  pool: pg.Pool;
  engine: MarketDataEngine;
};

export function registerMarketDataRoutes(options: MarketDataRouteOptions): void {
  const { app, engine } = options;
  const store = new MarketDataStore(options.pool);
  engines.set(app, engine);

  app.get('/internal/market-data/health', async (request, reply) => {
    noStore(reply);
    const auth = await requireRead(options.auth, request);
    requireStaffAccess(auth, PERMISSIONS.marketDataHealth);
    return sendJson(reply, 200, feedHealthSchema, engine.health());
  });

  app.get('/market-data/quotes/:symbol', async (request, reply) => {
    noStore(reply);
    const auth = await requireRead(options.auth, request);
    requirePermission(auth, PERMISSIONS.marketDataRead);
    const params = parseWithSchema(symbolParams, request.params);
    const quote = engine.quote(params.symbol);
    if (!quote) throw new AppError('NOT_FOUND', 404, 'Not found');
    const health = engine.health();
    return sendJson(reply, 200, quoteSnapshotSchema, {
      symbol: quote.symbol,
      market: quote.market,
      venue: quote.venue,
      bid: quote.bid,
      ask: quote.ask,
      bidSize: quote.bidSize,
      askSize: quote.askSize,
      last: quote.last,
      sourceTimestamp: quote.sourceTimestamp,
      receivedTimestamp: quote.receivedTimestamp,
      processedTimestamp: quote.processedTimestamp,
      sequence: quote.sequence,
      priceOrigin: quote.priceOrigin,
      liveMarketData: false,
      feedState: health.feedState,
    });
  });

  app.get('/market-data/bars', async (request, reply) => {
    noStore(reply);
    const auth = await requireRead(options.auth, request, barsQuerySchema);
    requirePermission(auth, PERMISSIONS.marketDataRead);
    const query = barsQuerySchema.parse(request.query);
    const bars = await store.readBars(query.symbol, query.timeframe, query.limit);
    return sendJson(reply, 200, barListResponseSchema, {
      bars: bars.map((bar) => ({
        symbol: bar.symbol,
        timeframe: bar.timeframe,
        bucketStart: bar.bucketStart,
        open: trimDecimal(bar.open),
        high: trimDecimal(bar.high),
        low: trimDecimal(bar.low),
        close: trimDecimal(bar.close),
        volume: trimDecimal(bar.volume),
        tradeCount: bar.tradeCount,
        priceOrigin: bar.priceOrigin,
        liveMarketData: false as const,
      })),
      priceOrigin: engine.health().priceOrigin,
      liveMarketData: false as const,
    });
  });

  app.post('/staff/market-data/instruments', async (request, reply) => {
    noStore(reply);
    const auth = await requireWrite(options.auth, request);
    requireStaffAccess(auth, PERMISSIONS.marketDataManage);
    parseWithSchema(emptyQuerySchema, request.query);
    const body = parseWithSchema(instrumentRequestSchema, request.body);
    try {
      const created = await store.insertInstrument(body);
      engine.register(created);
      return await sendJson(reply, 201, instrumentResponseSchema, created);
    } catch (error) {
      if (isUnique(error)) {
        throw new AppError('CONFLICT', 409, 'The instrument already exists');
      }
      throw error;
    }
  });
}

function trimDecimal(value: string): string {
  return value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function isUnique(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
