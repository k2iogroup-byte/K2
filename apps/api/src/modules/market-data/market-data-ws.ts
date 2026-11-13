import { marketDataClientMessageSchema } from '@k2/shared';
import type { FastifyInstance } from 'fastify';

import type { AppConfig } from '../../config/env.js';
import { isAllowedOrigin } from '../../infrastructure/http/origin.js';
import type { AuthService } from '../auth/auth-service.js';
import { readOpaqueCookie, SESSION_COOKIE } from '../auth/cookies.js';
import { PERMISSIONS } from '../auth/rbac.js';
import type { DistributionEvent, MarketDataEngine } from './engine.js';

const SLOW_CONSUMER_BYTES = 1_048_576;

type WsMessageHandler = {
  bufferedAmount?: number;
  on(event: 'message', listener: (raw: Buffer | string) => void): void;
  on(event: 'close', listener: () => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export function registerMarketDataSocket(
  app: FastifyInstance,
  config: Pick<AppConfig, 'corsOrigins'>,
  auth: AuthService,
  engine: MarketDataEngine,
): void {
  app.get('/ws/market-data', { websocket: true }, (socket: WsMessageHandler, request) => {
    const origin = readOrigin(request.headers);
    if (!isAllowedOrigin(origin, config.corsOrigins)) {
      socket.close(1008, 'origin not allowed');
      return;
    }
    const queued: (Buffer | string)[] = [];
    let ready = false;
    let closed = false;
    let unsubscribe: (() => void) | null = null;
    const stop = (): void => {
      if (!unsubscribe) return;
      unsubscribe();
      unsubscribe = null;
    };
    const handle = (raw: Buffer | string, symbols: Set<string>): void => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      let payload: unknown;
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        socket.send(JSON.stringify({ type: 'error', code: 'VALIDATION_ERROR' }));
        return;
      }
      const parsed = marketDataClientMessageSchema.safeParse(payload);
      if (!parsed.success) {
        socket.send(JSON.stringify({ type: 'error', code: 'VALIDATION_ERROR' }));
        return;
      }
      if (parsed.data.type === 'ping') {
        socket.send(
          JSON.stringify({
            type: 'pong',
            timestamp: new Date().toISOString(),
            liveMarketData: false,
          }),
        );
        return;
      }
      if (parsed.data.type === 'unsubscribe') {
        symbols.clear();
        socket.send(JSON.stringify({ type: 'subscribed', symbols: [] }));
        return;
      }
      symbols.clear();
      for (const symbol of parsed.data.symbols) symbols.add(symbol);
      socket.send(
        JSON.stringify({
          type: 'subscribed',
          symbols: [...symbols],
          health: engine.health(),
        }),
      );
    };
    const symbols = new Set<string>();
    socket.on('close', () => {
      closed = true;
      stop();
    });
    socket.on('message', (raw) => {
      if (!ready) {
        queued.push(raw);
        return;
      }
      handle(raw, symbols);
    });
    void auth.loadSession(readOpaqueCookie(request, SESSION_COOKIE)).then((session) => {
      if (closed) return;
      if (
        !session ||
        session.emailVerifiedAt === null ||
        !session.permissions.has(PERMISSIONS.marketDataRead)
      ) {
        socket.close(1008, 'sign in required');
        return;
      }
      unsubscribe = engine.subscribe((event) => {
        if (closed) return;
        if ((socket.bufferedAmount ?? 0) > SLOW_CONSUMER_BYTES) {
          stop();
          socket.close(1008, 'slow consumer');
          return;
        }
        if (event.type === 'quote' && !symbols.has(event.quote.symbol)) return;
        if (event.type === 'trade' && !symbols.has(event.trade.symbol)) return;
        if (event.type === 'gap' && !symbols.has(event.symbol)) return;
        try {
          socket.send(JSON.stringify(outbound(event)));
        } catch {
          stop();
        }
      });
      ready = true;
      for (const raw of queued) handle(raw, symbols);
    });
  });
}

function outbound(event: DistributionEvent): unknown {
  if (event.type === 'quote') {
    return {
      type: 'quote',
      symbol: event.quote.symbol,
      bid: event.quote.bid,
      ask: event.quote.ask,
      sequence: event.quote.sequence,
      priceOrigin: event.quote.priceOrigin,
      liveMarketData: false,
    };
  }
  if (event.type === 'trade') {
    return {
      type: 'trade',
      symbol: event.trade.symbol,
      price: event.trade.price,
      quantity: event.trade.quantity,
      sequence: event.trade.sequence,
      priceOrigin: event.trade.priceOrigin,
      liveMarketData: false,
    };
  }
  if (event.type === 'feed') {
    return { type: 'feed', ...event.health, liveMarketData: false };
  }
  return {
    type: 'gap',
    symbol: event.symbol,
    previousSequence: event.previousSequence,
    sequence: event.sequence,
  };
}

function readOrigin(headers: unknown): string | undefined {
  if (typeof headers !== 'object' || headers === null || !('origin' in headers)) return undefined;
  const value = headers.origin;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}
