import type { PriceOrigin } from '@k2/shared';

import type { RawProviderEvent, RawQuote } from './engine.js';
import type { FeedLink } from './feed-reconnect.js';

/** Marker required on every recorded payload. These files are not live prices. */
export const RECORDED_FIXTURE_LABEL = 'RECORDED_FIXTURE_NOT_LIVE_MARKET_DATA' as const;

export const BINANCE_BOOK_TICKER_SOURCE = 'binance-public:bookTicker';

export type RecordedBookTicker = {
  fixture: typeof RECORDED_FIXTURE_LABEL;
  u: string;
  s: string;
  b: string;
  B: string;
  a: string;
  A: string;
};

/**
 * Public Binance market data only. `start` does not open a socket.
 * While the link is down, recorded quotes are not delivered.
 */
export class BinancePublicProvider {
  readonly id = 'binance-public';
  readonly priceOrigin: PriceOrigin = 'VENDOR';
  private handler: ((event: RawProviderEvent) => void) | null = null;
  private link: FeedLink = 'down';

  start(onEvent: (event: RawProviderEvent) => void): void {
    this.handler = onEvent;
    this.link = 'up';
    this.handler({ kind: 'reconnect' });
  }

  stop(): void {
    if (this.link === 'up') this.handler?.({ kind: 'disconnect' });
    this.link = 'down';
    this.handler = null;
  }

  markDisconnected(): void {
    if (this.link === 'down') return;
    this.link = 'down';
    this.handler?.({ kind: 'disconnect' });
  }

  markReconnected(): void {
    if (!this.handler || this.link === 'up') return;
    this.link = 'up';
    this.handler({ kind: 'reconnect' });
  }

  /** Apply one recorded bookTicker. Ignored without the fixture label, or while the link is down. */
  emitRecorded(payload: unknown, receivedAt: Date): RawQuote | null {
    const quote = recordedBookTickerToQuote(payload, receivedAt);
    if (!quote || !this.handler || this.link !== 'up') return this.link === 'up' ? quote : null;
    this.handler(quote);
    return quote;
  }
}

export function recordedBookTickerToQuote(payload: unknown, receivedAt: Date): RawQuote | null {
  if (!isRecordedBookTicker(payload)) return null;
  return {
    kind: 'quote',
    providerEventId: `${BINANCE_BOOK_TICKER_SOURCE}:${payload.u}`,
    providerSymbol: payload.s.toLowerCase(),
    bid: payload.b,
    ask: payload.a,
    bidSize: payload.B,
    askSize: payload.A,
    last: null,
    sourceTimestamp: receivedAt.toISOString(),
    sequence: safeSequence(payload.u),
    quoteUpdateId: payload.u,
  };
}

function isRecordedBookTicker(payload: unknown): payload is RecordedBookTicker {
  if (typeof payload !== 'object' || payload === null) return false;
  const row = payload as Record<string, unknown>;
  return (
    row.fixture === RECORDED_FIXTURE_LABEL &&
    typeof row.u === 'string' &&
    /^[0-9]+$/.test(row.u) &&
    typeof row.s === 'string' &&
    typeof row.b === 'string' &&
    typeof row.B === 'string' &&
    typeof row.a === 'string' &&
    typeof row.A === 'string'
  );
}

function safeSequence(updateId: string): number {
  const value = Number(updateId);
  if (!Number.isSafeInteger(value)) return 0;
  return value;
}
