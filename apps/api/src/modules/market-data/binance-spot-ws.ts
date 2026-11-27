import type { RawProviderEvent, RawQuote } from './engine.js';
import { backoffDelayMs } from './feed-reconnect.js';

/** Public Spot book ticker. The socket URL has no API key. */
export const BINANCE_SPOT_WS_URL = 'wss://stream.binance.com:9443/ws';

export const MAX_STREAMS_PER_CONNECTION = 1024;
export const MAX_OUTBOUND_PER_SECOND = 5;
export const CONNECTION_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const SUBSCRIBE_BATCH_SIZE = 200;

const DECIMAL = /^(0|[1-9]\d*)(?:\.\d+)?$/;

export type SocketLike = {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
};

export type SocketConnector = (url: string) => SocketLike;

export type FeedClock = {
  now(): number;
  delay(ms: number, fn: () => void): () => void;
};

type Connection = {
  socket: SocketLike;
  streams: Set<string>;
  sentAt: number[];
  cancelLifetime: () => void;
};

const systemClock: FeedClock = {
  now: () => Date.now(),
  delay(ms, fn) {
    const timer = setTimeout(fn, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};

/**
 * Live bookTicker feed. Construct it only for `binance-public`.
 * Tests pass a fake connector and clock so no socket leaves the process.
 */
export class BinanceBookTickerFeed {
  private readonly connections: Connection[] = [];
  private readonly wanted = new Set<string>();
  private pending: string[] = [];
  private stopped = false;
  private attempt = 1;
  private nextId = 1;
  private flushTimer: (() => void) | null = null;
  private reconnectTimer: (() => void) | null = null;

  constructor(
    private readonly options: {
      connect: SocketConnector;
      onEvent: (event: RawProviderEvent) => void;
      clock?: FeedClock;
      random?: () => number;
      batchSize?: number;
      url?: string;
    },
  ) {}

  subscribe(symbols: readonly string[]): void {
    if (this.stopped) return;
    for (const symbol of symbols) {
      const stream = usdtBookTicker(symbol);
      if (!stream || this.wanted.has(stream)) continue;
      this.wanted.add(stream);
      this.pending.push(stream);
    }
    if (this.pending.length === 0) return;
    if (this.connections.length === 0 && !this.reconnectTimer) this.openConnection();
    this.flush();
  }

  stop(): void {
    this.stopped = true;
    this.flushTimer?.();
    this.flushTimer = null;
    this.reconnectTimer?.();
    this.reconnectTimer = null;
    for (const connection of this.connections.splice(0)) {
      connection.cancelLifetime();
      connection.socket.close();
    }
    this.pending = [];
    this.options.onEvent({ kind: 'disconnect' });
  }

  private clock(): FeedClock {
    return this.options.clock ?? systemClock;
  }

  private openConnection(): void {
    if (this.stopped) return;
    const socket = this.options.connect(this.options.url ?? BINANCE_SPOT_WS_URL);
    const connection: Connection = {
      socket,
      streams: new Set(),
      sentAt: [],
      cancelLifetime: () => undefined,
    };
    this.connections.push(connection);
    socket.onMessage((data) => {
      this.onMessage(data);
    });
    socket.onClose(() => {
      this.onSocketClose(connection);
    });
    connection.cancelLifetime = this.clock().delay(CONNECTION_LIFETIME_MS, () => {
      if (!this.stopped) socket.close();
    });
    this.attempt = 1;
    this.options.onEvent({ kind: 'reconnect' });
    this.flush();
  }

  private onSocketClose(connection: Connection): void {
    connection.cancelLifetime();
    const index = this.connections.indexOf(connection);
    if (index >= 0) this.connections.splice(index, 1);
    for (const stream of connection.streams) {
      if (this.wanted.has(stream) && !this.pending.includes(stream)) this.pending.push(stream);
    }
    if (this.stopped) return;
    if (this.connections.length === 0) this.options.onEvent({ kind: 'disconnect' });
    if (this.pending.length === 0 || this.reconnectTimer) return;
    const wait = backoffDelayMs(this.attempt, this.options.random);
    this.attempt += 1;
    this.reconnectTimer = this.clock().delay(wait, () => {
      this.reconnectTimer = null;
      if (!this.stopped && this.pending.length > 0) this.openConnection();
    });
  }

  private onMessage(data: string): void {
    const quote = parseBookTickerMessage(data, new Date(this.clock().now()));
    if (quote) this.options.onEvent(quote);
  }

  private flush(): void {
    const batchSize = this.options.batchSize ?? SUBSCRIBE_BATCH_SIZE;
    while (this.pending.length > 0) {
      const connection = this.connections.find(
        (item) => item.streams.size < MAX_STREAMS_PER_CONNECTION && this.slots(item) > 0,
      );
      if (!connection) {
        const hasRoom = this.connections.some(
          (item) => item.streams.size < MAX_STREAMS_PER_CONNECTION,
        );
        if (!hasRoom) {
          this.openConnection();
          continue;
        }
        this.scheduleFlush();
        return;
      }
      const room = MAX_STREAMS_PER_CONNECTION - connection.streams.size;
      const params = this.pending.splice(0, Math.min(batchSize, room));
      connection.socket.send(JSON.stringify({ method: 'SUBSCRIBE', params, id: this.nextId }));
      this.nextId += 1;
      connection.sentAt.push(this.clock().now());
      for (const stream of params) connection.streams.add(stream);
    }
  }

  private slots(connection: Connection): number {
    const now = this.clock().now();
    connection.sentAt = connection.sentAt.filter((sent) => now - sent < 1_000);
    return MAX_OUTBOUND_PER_SECOND - connection.sentAt.length;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    const now = this.clock().now();
    let wait = 1_000;
    for (const connection of this.connections) {
      if (connection.streams.size >= MAX_STREAMS_PER_CONNECTION) continue;
      const oldest = connection.sentAt[0];
      if (oldest !== undefined) wait = Math.min(wait, Math.max(0, oldest + 1_000 - now));
    }
    this.flushTimer = this.clock().delay(wait, () => {
      this.flushTimer = null;
      this.flush();
    });
  }
}

export function openLiveBookTickerFeed(options: {
  mode: 'disconnected' | 'test-fixture' | 'binance-public';
  connect: SocketConnector;
  onEvent: (event: RawProviderEvent) => void;
  clock?: FeedClock;
  random?: () => number;
  batchSize?: number;
}): BinanceBookTickerFeed | null {
  if (options.mode !== 'binance-public') return null;
  return new BinanceBookTickerFeed(options);
}

/** Node's global WebSocket. Called only when the live feed is actually opened. */
export function nodeWebSocketConnector(url: string): SocketLike {
  const socket = new WebSocket(url);
  return {
    send(data) {
      socket.send(data);
    },
    close() {
      socket.close();
    },
    onMessage(handler) {
      socket.addEventListener('message', (event: MessageEvent) => {
        if (typeof event.data === 'string') handler(event.data);
      });
    },
    onClose(handler) {
      socket.addEventListener('close', () => {
        handler();
      });
    },
  };
}

export function parseBookTickerMessage(raw: string, receivedAt: Date): RawQuote | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(quoteUpdateId(raw)) as unknown;
  } catch {
    return null;
  }
  const body = unwrap(parsed);
  if (!body) return null;
  const updateId = body.u;
  const symbol = body.s;
  const bid = body.b;
  const bidSize = body.B;
  const ask = body.a;
  const askSize = body.A;
  if (
    typeof updateId !== 'string' ||
    !/^[0-9]+$/.test(updateId) ||
    typeof symbol !== 'string' ||
    typeof bid !== 'string' ||
    typeof bidSize !== 'string' ||
    typeof ask !== 'string' ||
    typeof askSize !== 'string' ||
    !DECIMAL.test(bid) ||
    !DECIMAL.test(bidSize) ||
    !DECIMAL.test(ask) ||
    !DECIMAL.test(askSize)
  ) {
    return null;
  }
  return {
    kind: 'quote',
    providerEventId: `binance-public:bookTicker:${updateId}:${symbol.toLowerCase()}`,
    providerSymbol: symbol.toLowerCase(),
    bid,
    ask,
    bidSize,
    askSize,
    last: null,
    sourceTimestamp: receivedAt.toISOString(),
    sequence: safeSequence(updateId),
    quoteUpdateId: updateId,
  };
}

export function usdtBookTicker(symbol: string): string | null {
  const upper = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,32}$/.test(upper) || !upper.endsWith('USDT')) return null;
  return `${upper.toLowerCase()}@bookTicker`;
}

function quoteUpdateId(raw: string): string {
  return raw.replace(/"u"\s*:\s*(\d+)/g, '"u":"$1"');
}

function unwrap(parsed: unknown): Record<string, string> | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const row = parsed as Record<string, unknown>;
  const data = row.data;
  const source =
    typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : row;
  const text: Record<string, string> = {};
  for (const key of ['u', 's', 'b', 'B', 'a', 'A']) {
    const value = source[key];
    if (typeof value === 'string') text[key] = value;
  }
  return text;
}

function safeSequence(updateId: string): number {
  const value = Number(updateId);
  if (!Number.isSafeInteger(value)) return 0;
  return value;
}
