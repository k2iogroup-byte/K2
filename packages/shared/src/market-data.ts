import { z } from 'zod';

export const MARKETS = ['EQUITIES', 'CRYPTO'] as const;
export const VENUES = ['NYSE', 'NASDAQ', 'BINANCE_SPOT'] as const;
export const FEED_STATES = ['LIVE', 'DEGRADED', 'STALE', 'DISCONNECTED'] as const;
export const PRICE_ORIGINS = ['TEST_FIXTURE', 'VENDOR'] as const;
export const BAR_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;

const symbolSchema = z.string().regex(/^[A-Z0-9][A-Z0-9.-]{0,31}$/);
const decimalSchema = z.string().regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,8})?$/);

export const feedHealthSchema = z
  .strictObject({
    feedState: z.enum(FEED_STATES),
    priceOrigin: z.enum(PRICE_ORIGINS),
    liveMarketData: z.boolean(),
    providerId: z.string().min(1).max(64),
    redistributionLicensed: z.literal(false),
    detail: z.string(),
  })
  .superRefine((value, context) => {
    if (value.priceOrigin === 'TEST_FIXTURE' && value.liveMarketData) {
      context.addIssue({ code: 'custom', path: ['liveMarketData'], message: 'Invalid value' });
    }
    if (value.feedState !== 'LIVE' && value.liveMarketData) {
      context.addIssue({ code: 'custom', path: ['liveMarketData'], message: 'Invalid value' });
    }
  });

export const quoteSnapshotSchema = z.strictObject({
  symbol: symbolSchema,
  market: z.enum(MARKETS),
  venue: z.enum(VENUES),
  bid: decimalSchema,
  ask: decimalSchema,
  bidSize: decimalSchema,
  askSize: decimalSchema,
  last: decimalSchema.nullable(),
  sourceTimestamp: z.string(),
  receivedTimestamp: z.string(),
  processedTimestamp: z.string(),
  sequence: z.number().int().nonnegative(),
  priceOrigin: z.enum(PRICE_ORIGINS),
  liveMarketData: z.literal(false),
  feedState: z.enum(FEED_STATES),
});

export const barSchema = z.strictObject({
  symbol: symbolSchema,
  timeframe: z.enum(BAR_TIMEFRAMES),
  bucketStart: z.string(),
  open: decimalSchema,
  high: decimalSchema,
  low: decimalSchema,
  close: decimalSchema,
  volume: decimalSchema,
  tradeCount: z.number().int().positive(),
  priceOrigin: z.enum(PRICE_ORIGINS),
  liveMarketData: z.literal(false),
});

export const barListResponseSchema = z.strictObject({
  bars: z.array(barSchema),
  priceOrigin: z.enum(PRICE_ORIGINS),
  liveMarketData: z.literal(false),
});

export const instrumentRequestSchema = z
  .strictObject({
    market: z.enum(MARKETS),
    venue: z.enum(VENUES),
    symbol: symbolSchema,
    providerSymbol: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .transform((value) => value.toLowerCase()),
    priceScale: z.number().int().min(0).max(8),
    quantityScale: z.number().int().min(0).max(8),
  })
  .superRefine((value, context) => {
    const crypto = value.market === 'CRYPTO';
    const equityVenue = value.venue === 'NYSE' || value.venue === 'NASDAQ';
    if (crypto !== (value.venue === 'BINANCE_SPOT') || (!crypto && !equityVenue)) {
      context.addIssue({ code: 'custom', path: ['venue'], message: 'Invalid value' });
    }
  });

export const instrumentResponseSchema = z.strictObject({
  id: z.uuid(),
  market: z.enum(MARKETS),
  venue: z.enum(VENUES),
  symbol: symbolSchema,
  providerSymbol: z.string(),
  priceScale: z.number().int(),
  quantityScale: z.number().int(),
});

export const marketDataClientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ping') }),
  z.strictObject({
    type: z.literal('subscribe'),
    symbols: z.array(symbolSchema).min(1).max(20),
  }),
  z.strictObject({ type: z.literal('unsubscribe') }),
]);

export type FeedState = (typeof FEED_STATES)[number];
export type PriceOrigin = (typeof PRICE_ORIGINS)[number];
export type BarTimeframe = (typeof BAR_TIMEFRAMES)[number];
export type MarketCode = (typeof MARKETS)[number];
export type VenueCode = (typeof VENUES)[number];
