import { describe, expect, it } from 'vitest';

import {
  BINANCE_SPOT_WS_URL,
  type BinanceBookTickerFeed,
  CONNECTION_LIFETIME_MS,
  type FeedClock,
  MAX_STREAMS_PER_CONNECTION,
  openLiveBookTickerFeed,
  parseBookTickerMessage,
  type SocketLike,
} from '../../src/modules/market-data/binance-spot-ws.js';
import { MarketDataEngine } from '../../src/modules/market-data/engine.js';

class ManualClock implements FeedClock {
  private time = 0;
  private nextId = 1;
  private timers: { id: number; at: number; fn: () => void }[] = [];

  now(): number {
    return this.time;
  }

  delay(ms: number, fn: () => void): () => void {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.push({ id, at: this.time + ms, fn });
    return () => {
      this.timers = this.timers.filter((timer) => timer.id !== id);
    };
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at);
      const next = due[0];
      if (!next) break;
      this.timers = this.timers.filter((timer) => timer.id !== next.id);
      this.time = next.at;
      next.fn();
    }
    this.time = target;
  }
}

class MockSocket implements SocketLike {
  readonly sent: string[] = [];
  closed = false;
  private message: ((data: string) => void) | null = null;
  private closedHandler: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.closedHandler?.();
  }

  onMessage(handler: (data: string) => void): void {
    this.message = handler;
  }

  onClose(handler: () => void): void {
    this.closedHandler = handler;
  }

  receive(data: string): void {
    this.message?.(data);
  }

  drop(): void {
    this.closedHandler?.();
  }
}

function harness(batchSize = 200): {
  clock: ManualClock;
  sockets: MockSocket[];
  feed: BinanceBookTickerFeed;
  events: string[];
} {
  const clock = new ManualClock();
  const sockets: MockSocket[] = [];
  const events: string[] = [];
  const feed = openLiveBookTickerFeed({
    mode: 'binance-public',
    connect: (url) => {
      expect(url).toBe(BINANCE_SPOT_WS_URL);
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    onEvent: (event) => {
      events.push(event.kind);
    },
    clock,
    random: () => 1,
    batchSize,
  });
  if (!feed) throw new Error('live feed was not opened');
  return { clock, sockets, feed, events };
}

describe('binance spot websocket', () => {
  it('parses a live bookTicker and a recorded fixture without using a float', () => {
    const received = new Date('2026-11-21T00:00:00.000Z');
    const live = parseBookTickerMessage(
      '{"u":400900217,"s":"BTCUSDT","b":"65000.10","B":"0.50000000","a":"65000.20","A":"0.50000000"}',
      received,
    );
    expect(live?.quoteUpdateId).toBe('400900217');
    expect(live?.bid).toBe('65000.10');
    expect(live?.providerSymbol).toBe('btcusdt');
    const recorded = parseBookTickerMessage(
      '{"fixture":"RECORDED_FIXTURE_NOT_LIVE_MARKET_DATA","u":"12","s":"ETHUSDT","b":"1.00","B":"1","a":"1.10","A":"2"}',
      received,
    );
    expect(recorded?.quoteUpdateId).toBe('12');
    const wrapped = parseBookTickerMessage(
      '{"stream":"ethusdt@bookTicker","data":{"u":9,"s":"ETHUSDT","b":"1","B":"1","a":"2","A":"1"}}',
      received,
    );
    expect(wrapped?.providerSymbol).toBe('ethusdt');
    expect(parseBookTickerMessage('{"result":null,"id":1}', received)).toBeNull();
  });

  it('stays offline unless the mode is binance-public', () => {
    const connect = (): SocketLike => {
      throw new Error('connect must not run');
    };
    expect(
      openLiveBookTickerFeed({
        mode: 'disconnected',
        connect,
        onEvent: () => undefined,
      }),
    ).toBeNull();
    expect(
      openLiveBookTickerFeed({
        mode: 'test-fixture',
        connect,
        onEvent: () => undefined,
      }),
    ).toBeNull();
  });

  it('subscribes USDT pairs on demand, batches, and waits out the five-message limit', () => {
    const { clock, sockets, feed } = harness(1);
    feed.subscribe(['ETHUSDC', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT']);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.sent).toHaveLength(5);
    const first = JSON.parse(sockets[0]?.sent[0] ?? '{}') as { params: string[] };
    expect(first.params).toEqual(['btcusdt@bookTicker']);
    expect(sockets[0]?.sent.join(' ')).not.toContain('ethusdc');
    clock.advance(1_000);
    expect(sockets[0]?.sent).toHaveLength(6);
  });

  it('opens another connection after 1024 streams', () => {
    const { sockets, feed } = harness(MAX_STREAMS_PER_CONNECTION);
    const symbols = Array.from({ length: MAX_STREAMS_PER_CONNECTION + 1 }, (_unused, index) => {
      return `S${index}USDT`;
    });
    feed.subscribe(symbols);
    expect(sockets).toHaveLength(2);
    const first = JSON.parse(sockets[0]?.sent[0] ?? '{}') as { params: string[] };
    const second = JSON.parse(sockets[1]?.sent[0] ?? '{}') as { params: string[] };
    expect(first.params).toHaveLength(MAX_STREAMS_PER_CONNECTION);
    expect(second.params).toEqual(['s1024usdt@bookTicker']);
  });

  it('reconnects after a drop and after the 24 hour lifetime, then resubscribes', () => {
    const { clock, sockets, feed, events } = harness(10);
    feed.subscribe(['BTCUSDT']);
    expect(events).toContain('reconnect');
    sockets[0]?.drop();
    expect(events).toContain('disconnect');
    clock.advance(1_000);
    expect(sockets).toHaveLength(2);
    expect(JSON.parse(sockets[1]?.sent[0] ?? '{}')).toMatchObject({
      params: ['btcusdt@bookTicker'],
    });
    clock.advance(CONNECTION_LIFETIME_MS);
    clock.advance(1_000);
    expect(sockets).toHaveLength(3);
    expect(sockets[1]?.closed).toBe(true);
    expect(JSON.parse(sockets[2]?.sent[0] ?? '{}')).toMatchObject({
      params: ['btcusdt@bookTicker'],
    });
    feed.stop();
  });

  it('feeds a normalised quote into the engine listener', () => {
    const engine = new MarketDataEngine({ providerId: 'binance-public', priceOrigin: 'VENDOR' }, [
      {
        id: '00000000-0000-4000-8000-0000000000b1',
        market: 'CRYPTO',
        venue: 'BINANCE_SPOT',
        symbol: 'BTCUSDT',
        providerSymbol: 'btcusdt',
        priceScale: 2,
        quantityScale: 8,
      },
    ]);
    const seen: string[] = [];
    engine.subscribe((event) => {
      if (event.type === 'quote') seen.push(event.quote.quoteUpdateId);
    });
    const { sockets, feed } = harness();
    feed.subscribe(['BTCUSDT']);
    const received = new Date(0);
    sockets[0]?.receive(
      '{"u":15,"s":"BTCUSDT","b":"10.00","B":"1.00000000","a":"10.10","A":"1.00000000"}',
    );
    return engine
      .ingest(
        parseBookTickerMessage(
          '{"u":15,"s":"BTCUSDT","b":"10.00","B":"1.00000000","a":"10.10","A":"1.00000000"}',
          received,
        ) ?? { kind: 'disconnect' },
        received,
      )
      .then(() => {
        expect(engine.quote('BTCUSDT', received)?.bid).toBe('10.00');
        expect(seen).toEqual(['15']);
      });
  });
});
