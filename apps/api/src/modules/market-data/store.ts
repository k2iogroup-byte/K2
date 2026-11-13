import type { BarTimeframe, FeedState, MarketCode, PriceOrigin, VenueCode } from '@k2/shared';
import type pg from 'pg';

import type { Bar, FeedHealth, InstrumentDefinition, NormalisedQuote } from './engine.js';

export class MarketDataStore {
  constructor(private readonly pool: pg.Pool) {}

  async insertInstrument(input: {
    market: MarketCode;
    venue: VenueCode;
    symbol: string;
    providerSymbol: string;
    priceScale: number;
    quantityScale: number;
  }): Promise<InstrumentDefinition & { id: string }> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO instruments (
         market, venue, symbol, provider_symbol, price_scale, quantity_scale
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        input.market,
        input.venue,
        input.symbol,
        input.providerSymbol,
        input.priceScale,
        input.quantityScale,
      ],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error('Instrument insert did not return an id');
    return { ...input, id };
  }

  async listInstruments(): Promise<InstrumentDefinition[]> {
    try {
      return await this.queryInstruments();
    } catch (error) {
      if (pgCode(error) === '42P01') return [];
      throw error;
    }
  }

  private async queryInstruments(): Promise<InstrumentDefinition[]> {
    const result = await this.pool.query<{
      id: string;
      market: MarketCode;
      venue: VenueCode;
      symbol: string;
      provider_symbol: string;
      price_scale: number;
      quantity_scale: number;
    }>(
      `SELECT id, market, venue, symbol, provider_symbol, price_scale, quantity_scale
       FROM instruments
       ORDER BY venue, symbol`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      market: row.market,
      venue: row.venue,
      symbol: row.symbol,
      providerSymbol: row.provider_symbol,
      priceScale: row.price_scale,
      quantityScale: row.quantity_scale,
    }));
  }

  async findInstrument(symbol: string): Promise<InstrumentDefinition | null> {
    const result = await this.pool.query<{
      id: string;
      market: MarketCode;
      venue: VenueCode;
      symbol: string;
      provider_symbol: string;
      price_scale: number;
      quantity_scale: number;
    }>(
      `SELECT id, market, venue, symbol, provider_symbol, price_scale, quantity_scale
       FROM instruments WHERE symbol = $1`,
      [symbol],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      market: row.market,
      venue: row.venue,
      symbol: row.symbol,
      providerSymbol: row.provider_symbol,
      priceScale: row.price_scale,
      quantityScale: row.quantity_scale,
    };
  }

  async saveQuote(quote: NormalisedQuote, feedState: FeedState): Promise<void> {
    await this.pool.query(
      `INSERT INTO quote_snapshots (
         instrument_id, bid, ask, bid_size, ask_size, last_price, source_timestamp,
         received_timestamp, processed_timestamp, sequence_no, provider_event_id,
         price_origin, feed_state
       ) VALUES ($1, $2::numeric, $3::numeric, $4::numeric, $5::numeric, $6::numeric,
         $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (instrument_id) DO UPDATE SET
         bid = EXCLUDED.bid,
         ask = EXCLUDED.ask,
         bid_size = EXCLUDED.bid_size,
         ask_size = EXCLUDED.ask_size,
         last_price = EXCLUDED.last_price,
         source_timestamp = EXCLUDED.source_timestamp,
         received_timestamp = EXCLUDED.received_timestamp,
         processed_timestamp = EXCLUDED.processed_timestamp,
         sequence_no = EXCLUDED.sequence_no,
         provider_event_id = EXCLUDED.provider_event_id,
         price_origin = EXCLUDED.price_origin,
         feed_state = EXCLUDED.feed_state,
         updated_at = now()`,
      [
        quote.instrumentId,
        quote.bid,
        quote.ask,
        quote.bidSize,
        quote.askSize,
        quote.last,
        quote.sourceTimestamp,
        quote.receivedTimestamp,
        quote.processedTimestamp,
        quote.sequence,
        quote.providerEventId,
        quote.priceOrigin,
        feedState,
      ],
    );
  }

  async saveBars(bars: readonly Bar[]): Promise<void> {
    for (const bar of bars) {
      await this.pool.query(
        `INSERT INTO bars (
           instrument_id, timeframe, bucket_start, open, high, low, close, volume,
           trade_count, price_origin
         ) VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6::numeric, $7::numeric,
           $8::numeric, $9, $10)
         ON CONFLICT (instrument_id, timeframe, bucket_start) DO UPDATE SET
           high = EXCLUDED.high,
           low = EXCLUDED.low,
           close = EXCLUDED.close,
           volume = EXCLUDED.volume,
           trade_count = EXCLUDED.trade_count`,
        [
          bar.instrumentId,
          bar.timeframe,
          bar.bucketStart,
          bar.open,
          bar.high,
          bar.low,
          bar.close,
          bar.volume,
          bar.tradeCount,
          bar.priceOrigin,
        ],
      );
    }
  }

  async saveFeed(health: FeedHealth): Promise<void> {
    await this.pool.query(
      `INSERT INTO feed_status_events (
         provider_id, status, price_origin, live_market_data, detected_at, detail
       ) VALUES ($1, $2, $3, $4, now(), $5)`,
      [
        health.providerId,
        health.feedState,
        health.priceOrigin,
        health.liveMarketData,
        health.detail,
      ],
    );
  }

  async latestFeed(): Promise<FeedHealth | null> {
    const result = await this.pool.query<{
      provider_id: string;
      status: FeedState;
      price_origin: PriceOrigin;
      live_market_data: boolean;
      detail: string;
    }>(
      `SELECT provider_id, status, price_origin, live_market_data, detail
       FROM feed_status_events
       ORDER BY detected_at DESC, created_at DESC
       LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      feedState: row.status,
      priceOrigin: row.price_origin,
      liveMarketData: row.live_market_data,
      providerId: row.provider_id,
      redistributionLicensed: false,
      detail: row.detail,
    };
  }

  async readBars(symbol: string, timeframe: BarTimeframe, limit: number): Promise<Bar[]> {
    const result = await this.pool.query<{
      instrument_id: string;
      symbol: string;
      timeframe: BarTimeframe;
      bucket_start: Date;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
      trade_count: number;
      price_origin: PriceOrigin;
    }>(
      `SELECT b.instrument_id, i.symbol, b.timeframe, b.bucket_start, b.open::text, b.high::text,
              b.low::text, b.close::text, b.volume::text, b.trade_count, b.price_origin
       FROM bars b
       JOIN instruments i ON i.id = b.instrument_id
       WHERE i.symbol = $1 AND b.timeframe = $2
       ORDER BY b.bucket_start DESC
       LIMIT $3`,
      [symbol, timeframe, limit],
    );
    return result.rows
      .map((row) => ({
        instrumentId: row.instrument_id,
        symbol: row.symbol,
        timeframe: row.timeframe,
        bucketStart: row.bucket_start.toISOString(),
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        tradeCount: row.trade_count,
        priceOrigin: row.price_origin,
      }))
      .reverse();
  }
}

function pgCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return '';
}
