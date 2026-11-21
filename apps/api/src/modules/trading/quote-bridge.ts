import type { DistributionEvent, MarketDataEngine } from '../market-data/engine.js';
import type { Phase2Orders } from './phase2-orders.js';
import type { ExecutableQuote } from './trading-service.js';

/**
 * In-process listener. The market-data module does not import trading.
 * Quotes that arrive while one evaluation is running are coalesced inside onQuote.
 */
export function bindTradingQuotes(
  engine: MarketDataEngine,
  phase2: Phase2Orders,
): { unsubscribe(): void; idle(): Promise<void> } {
  let pending: Promise<void> = Promise.resolve();
  const unsubscribe = engine.subscribe((event: DistributionEvent) => {
    if (event.type !== 'quote') return;
    const quote: ExecutableQuote = {
      quoteUpdateId: event.quote.quoteUpdateId,
      bid: event.quote.bid,
      ask: event.quote.ask,
      bidSize: event.quote.bidSize,
      askSize: event.quote.askSize,
      receivedAt: new Date(event.quote.receivedTimestamp),
      feedState: event.feedState,
      priceOrigin: event.quote.priceOrigin,
    };
    pending = pending
      .then(() => phase2.onQuote(event.quote.instrumentId, quote))
      .catch(() => undefined);
  });
  return {
    unsubscribe,
    idle: () => pending,
  };
}
