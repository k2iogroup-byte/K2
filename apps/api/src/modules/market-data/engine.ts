import type { BarTimeframe, FeedState, MarketCode, PriceOrigin, VenueCode } from '@k2/shared';
import {
  addDecimals,
  canonicalDecimal,
  DecimalError,
  decimalGreaterThan,
  decimalLessThan,
} from '@k2/shared';

export const DEFAULT_STALE_AFTER_MS = {
  EQUITIES: 30_000,
  CRYPTO: 5_000,
} as const;

const SOURCE_SKEW_MS = 5_000;
const EVENT_ID_LIMIT = 4_096;
const TIMEFRAMES: readonly BarTimeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
const TIMEFRAME_MS: Record<BarTimeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export type InstrumentDefinition = {
  id: string;
  market: MarketCode;
  venue: VenueCode;
  symbol: string;
  providerSymbol: string;
  priceScale: number;
  quantityScale: number;
};

export type RawQuote = {
  kind: 'quote';
  providerEventId: string;
  providerSymbol: string;
  bid: string;
  ask: string;
  bidSize: string;
  askSize: string;
  last: string | null;
  sourceTimestamp: string;
  sequence: number;
};

export type RawTrade = {
  kind: 'trade';
  providerEventId: string;
  providerSymbol: string;
  price: string;
  quantity: string;
  sourceTimestamp: string;
  sequence: number;
};

export type RawProviderEvent = RawQuote | RawTrade | { kind: 'disconnect' } | { kind: 'reconnect' };

export type NormalisedQuote = {
  instrumentId: string;
  market: MarketCode;
  venue: VenueCode;
  symbol: string;
  bid: string;
  ask: string;
  bidSize: string;
  askSize: string;
  last: string | null;
  sourceTimestamp: string;
  receivedTimestamp: string;
  processedTimestamp: string;
  sequence: number;
  providerEventId: string;
  priceOrigin: PriceOrigin;
};

export type NormalisedTrade = {
  instrumentId: string;
  symbol: string;
  price: string;
  quantity: string;
  sourceTimestamp: string;
  receivedTimestamp: string;
  processedTimestamp: string;
  sequence: number;
  providerEventId: string;
  priceOrigin: PriceOrigin;
};

export type Bar = {
  instrumentId: string;
  symbol: string;
  timeframe: BarTimeframe;
  bucketStart: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  tradeCount: number;
  priceOrigin: PriceOrigin;
};

export type FeedHealth = {
  feedState: FeedState;
  priceOrigin: PriceOrigin;
  liveMarketData: boolean;
  providerId: string;
  redistributionLicensed: false;
  detail: string;
};

export type DistributionEvent =
  | { type: 'quote'; quote: NormalisedQuote; feedState: FeedState; liveMarketData: boolean }
  | { type: 'trade'; trade: NormalisedTrade; feedState: FeedState; liveMarketData: boolean }
  | { type: 'feed'; health: FeedHealth }
  | { type: 'gap'; symbol: string; previousSequence: number; sequence: number };

export type IngestResult =
  | { status: 'accepted'; kind: 'quote' | 'trade' }
  | { status: 'duplicate' }
  | { status: 'rejected'; reason: 'invalid' | 'out_of_order' | 'unknown_symbol' }
  | { status: 'disconnected' }
  | { status: 'reconnected' };

type InstrumentState = {
  definition: InstrumentDefinition;
  lastSequence: number | null;
  lastSourceMs: number | null;
  lastReceivedMs: number | null;
  degraded: boolean;
  eventIds: Set<string>;
  eventOrder: string[];
};

export type MarketDataSink = {
  saveQuote(quote: NormalisedQuote, feedState: FeedState): Promise<void>;
  saveBars(bars: readonly Bar[]): Promise<void>;
  saveFeed(health: FeedHealth): Promise<void>;
};

export function liveMarketDataClaim(origin: PriceOrigin, state: FeedState): boolean {
  return origin === 'VENDOR' && state === 'LIVE';
}

export function bucketStart(timestamp: Date, timeframe: BarTimeframe): Date {
  const size = TIMEFRAME_MS[timeframe];
  return new Date(Math.floor(timestamp.getTime() / size) * size);
}

function staleAfter(
  market: MarketCode,
  configured: { EQUITIES: number; CRYPTO: number } | undefined,
): number {
  if (market === 'CRYPTO') return configured?.CRYPTO ?? DEFAULT_STALE_AFTER_MS.CRYPTO;
  return configured?.EQUITIES ?? DEFAULT_STALE_AFTER_MS.EQUITIES;
}

export class MarketDataEngine {
  private readonly instruments = new Map<string, InstrumentState>();
  private readonly listeners = new Set<(event: DistributionEvent) => void>();
  private connected = false;
  private awaitingFreshEvent = true;
  private readonly bars = new Map<string, Bar>();
  private readonly quotes = new Map<string, NormalisedQuote>();
  private feedState: FeedState = 'DISCONNECTED';

  constructor(
    private readonly options: {
      providerId: string;
      priceOrigin: PriceOrigin;
      clock?: () => Date;
      staleAfterMs?: { EQUITIES: number; CRYPTO: number };
      sink?: MarketDataSink;
    },
    instruments: readonly InstrumentDefinition[] = [],
  ) {
    for (const instrument of instruments) this.register(instrument);
  }

  register(instrument: InstrumentDefinition): void {
    this.instruments.set(instrument.providerSymbol.toLowerCase(), {
      definition: instrument,
      lastSequence: null,
      lastSourceMs: null,
      lastReceivedMs: null,
      degraded: false,
      eventIds: new Set(),
      eventOrder: [],
    });
  }

  subscribe(listener: (event: DistributionEvent) => void): () => void {
    this.listeners.add(listener);
    listener({ type: 'feed', health: this.health() });
    return () => {
      this.listeners.delete(listener);
    };
  }

  health(now = this.now()): FeedHealth {
    const state = this.computeState(now);
    return {
      feedState: state,
      priceOrigin: this.options.priceOrigin,
      liveMarketData: liveMarketDataClaim(this.options.priceOrigin, state),
      providerId: this.options.providerId,
      redistributionLicensed: false,
      detail: this.detail(state),
    };
  }

  quote(symbol: string, now = this.now()): (NormalisedQuote & { feedState: FeedState }) | null {
    const quote = this.quotes.get(symbol);
    if (!quote) return null;
    return { ...quote, feedState: this.health(now).feedState };
  }

  barsFor(symbol: string, timeframe: BarTimeframe): Bar[] {
    return [...this.bars.values()]
      .filter((bar) => bar.symbol === symbol && bar.timeframe === timeframe)
      .sort((left, right) => left.bucketStart.localeCompare(right.bucketStart));
  }

  async ingest(event: RawProviderEvent, receivedAt = this.now()): Promise<IngestResult> {
    if (event.kind === 'disconnect') {
      this.connected = false;
      this.awaitingFreshEvent = true;
      await this.publishFeed();
      return { status: 'disconnected' };
    }
    if (event.kind === 'reconnect') {
      this.connected = true;
      this.awaitingFreshEvent = true;
      await this.publishFeed();
      return { status: 'reconnected' };
    }
    if (!this.connected) this.connected = true;
    const instrument = this.instruments.get(event.providerSymbol.toLowerCase());
    if (!instrument) return { status: 'rejected', reason: 'unknown_symbol' };
    if (instrument.eventIds.has(event.providerEventId)) return { status: 'duplicate' };
    const sourceMs = Date.parse(event.sourceTimestamp);
    const receivedMs = receivedAt.getTime();
    if (!Number.isFinite(sourceMs) || sourceMs > receivedMs + SOURCE_SKEW_MS) {
      instrument.degraded = true;
      await this.publishFeed();
      return { status: 'rejected', reason: 'invalid' };
    }
    if (
      (instrument.lastSequence !== null && event.sequence <= instrument.lastSequence) ||
      (instrument.lastSourceMs !== null && sourceMs < instrument.lastSourceMs)
    ) {
      instrument.degraded = true;
      await this.publishFeed();
      return { status: 'rejected', reason: 'out_of_order' };
    }
    const previousSequence = instrument.lastSequence;
    try {
      if (event.kind === 'quote') {
        const quote = this.normaliseQuote(event, instrument, receivedAt);
        rememberEvent(instrument, event.providerEventId);
        instrument.lastSequence = event.sequence;
        instrument.lastSourceMs = sourceMs;
        instrument.lastReceivedMs = receivedMs;
        instrument.degraded = false;
        this.awaitingFreshEvent = false;
        this.quotes.set(quote.symbol, quote);
        const health = this.health(receivedAt);
        await this.options.sink?.saveQuote(quote, health.feedState);
        this.emit({
          type: 'quote',
          quote,
          feedState: health.feedState,
          liveMarketData: health.liveMarketData,
        });
        this.emitGap(quote.symbol, previousSequence, event.sequence);
        await this.publishFeed();
        return { status: 'accepted', kind: 'quote' };
      }
      const trade = this.normaliseTrade(event, instrument, receivedAt);
      rememberEvent(instrument, event.providerEventId);
      instrument.lastSequence = event.sequence;
      instrument.lastSourceMs = sourceMs;
      instrument.lastReceivedMs = receivedMs;
      instrument.degraded = false;
      this.awaitingFreshEvent = false;
      const updated = this.applyTrade(trade);
      const health = this.health(receivedAt);
      await this.options.sink?.saveBars(updated);
      this.emit({
        type: 'trade',
        trade,
        feedState: health.feedState,
        liveMarketData: health.liveMarketData,
      });
      this.emitGap(trade.symbol, previousSequence, event.sequence);
      await this.publishFeed();
      return { status: 'accepted', kind: 'trade' };
    } catch (error) {
      if (!(error instanceof DecimalError)) throw error;
      instrument.degraded = true;
      await this.publishFeed();
      return { status: 'rejected', reason: 'invalid' };
    }
  }

  private normaliseQuote(
    event: RawQuote,
    instrument: InstrumentState,
    receivedAt: Date,
  ): NormalisedQuote {
    const scale = instrument.definition.priceScale;
    const quantityScale = instrument.definition.quantityScale;
    const bid = canonicalDecimal(event.bid, scale);
    const ask = canonicalDecimal(event.ask, scale);
    const bidSize = canonicalDecimal(event.bidSize, quantityScale);
    const askSize = canonicalDecimal(event.askSize, quantityScale);
    const last = event.last === null ? null : canonicalDecimal(event.last, scale);
    if (
      decimalLessThan(bid, '0', scale) ||
      decimalsNonPositive(bid, scale) ||
      decimalsNonPositive(ask, scale) ||
      decimalGreaterThan(bid, ask, scale) ||
      decimalLessThan(bidSize, '0', quantityScale) ||
      decimalLessThan(askSize, '0', quantityScale) ||
      (last !== null && decimalsNonPositive(last, scale))
    ) {
      throw new DecimalError();
    }
    const processed = this.now();
    return {
      instrumentId: instrument.definition.id,
      market: instrument.definition.market,
      venue: instrument.definition.venue,
      symbol: instrument.definition.symbol,
      bid,
      ask,
      bidSize,
      askSize,
      last,
      sourceTimestamp: new Date(event.sourceTimestamp).toISOString(),
      receivedTimestamp: receivedAt.toISOString(),
      processedTimestamp: processed.toISOString(),
      sequence: event.sequence,
      providerEventId: event.providerEventId,
      priceOrigin: this.options.priceOrigin,
    };
  }

  private normaliseTrade(
    event: RawTrade,
    instrument: InstrumentState,
    receivedAt: Date,
  ): NormalisedTrade {
    const price = canonicalDecimal(event.price, instrument.definition.priceScale);
    const quantity = canonicalDecimal(event.quantity, instrument.definition.quantityScale);
    if (
      decimalsNonPositive(price, instrument.definition.priceScale) ||
      decimalsNonPositive(quantity, instrument.definition.quantityScale)
    ) {
      throw new DecimalError();
    }
    return {
      instrumentId: instrument.definition.id,
      symbol: instrument.definition.symbol,
      price,
      quantity,
      sourceTimestamp: new Date(event.sourceTimestamp).toISOString(),
      receivedTimestamp: receivedAt.toISOString(),
      processedTimestamp: this.now().toISOString(),
      sequence: event.sequence,
      providerEventId: event.providerEventId,
      priceOrigin: this.options.priceOrigin,
    };
  }

  private applyTrade(trade: NormalisedTrade): Bar[] {
    const source = new Date(trade.sourceTimestamp);
    const updated: Bar[] = [];
    for (const timeframe of TIMEFRAMES) {
      const start = bucketStart(source, timeframe).toISOString();
      const key = `${trade.instrumentId}|${timeframe}|${start}`;
      const current = this.bars.get(key);
      const next: Bar = current
        ? {
            ...current,
            high: decimalGreaterThan(trade.price, current.high, 8) ? trade.price : current.high,
            low: decimalLessThan(trade.price, current.low, 8) ? trade.price : current.low,
            close: trade.price,
            volume: addDecimals(current.volume, trade.quantity, 8),
            tradeCount: current.tradeCount + 1,
          }
        : {
            instrumentId: trade.instrumentId,
            symbol: trade.symbol,
            timeframe,
            bucketStart: start,
            open: trade.price,
            high: trade.price,
            low: trade.price,
            close: trade.price,
            volume: canonicalDecimal(trade.quantity, 8),
            tradeCount: 1,
            priceOrigin: trade.priceOrigin,
          };
      this.bars.set(key, next);
      updated.push(next);
    }
    return updated;
  }

  private computeState(now: Date): FeedState {
    if (!this.connected) return 'DISCONNECTED';
    const states = [...this.instruments.values()];
    const seen = states.filter((state) => state.lastReceivedMs !== null);
    const stale = seen.some((state) => {
      const limit = staleAfter(state.definition.market, this.options.staleAfterMs);
      return now.getTime() - (state.lastReceivedMs ?? 0) > limit;
    });
    const allStale =
      seen.length > 0 &&
      seen.every((state) => {
        const limit = staleAfter(state.definition.market, this.options.staleAfterMs);
        return now.getTime() - (state.lastReceivedMs ?? 0) > limit;
      });
    if (stale && allStale) return 'STALE';
    if (stale || this.awaitingFreshEvent || states.some((state) => state.degraded))
      return 'DEGRADED';
    return 'LIVE';
  }

  private detail(state: FeedState): string {
    if (this.options.priceOrigin === 'TEST_FIXTURE') {
      return `${state} test fixture. These prices are not live market data.`;
    }
    if (state === 'LIVE')
      return 'Vendor feed is fresh. Redistribution is not licensed by this build.';
    return `${state}. The feed is not healthy.`;
  }

  private async publishFeed(): Promise<void> {
    const previous = this.feedState;
    const health = this.health();
    this.feedState = health.feedState;
    if (previous !== health.feedState) await this.options.sink?.saveFeed(health);
    this.emit({ type: 'feed', health });
  }

  private emitGap(symbol: string, previous: number | null, sequence: number): void {
    if (previous !== null && sequence > previous + 1) {
      this.emit({ type: 'gap', symbol, previousSequence: previous, sequence });
    }
  }

  private emit(event: DistributionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private now(): Date {
    return this.options.clock?.() ?? new Date();
  }
}

function rememberEvent(instrument: InstrumentState, eventId: string): void {
  instrument.eventIds.add(eventId);
  instrument.eventOrder.push(eventId);
  if (instrument.eventOrder.length <= EVENT_ID_LIMIT) return;
  const oldest = instrument.eventOrder.shift();
  if (oldest !== undefined) instrument.eventIds.delete(oldest);
}

function decimalsNonPositive(value: string, scale: number): boolean {
  return !decimalGreaterThan(value, '0', scale);
}
