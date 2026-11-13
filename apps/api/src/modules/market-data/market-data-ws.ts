import { marketDataClientMessageSchema } from '@k2/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AppConfig } from '../../config/env.js';
import { normalizeClientIp } from '../../infrastructure/http/client-ip.js';
import type { ConnectionLimiter } from '../../infrastructure/ws/connection-limits.js';
import { MessageWindow } from '../../infrastructure/ws/connection-limits.js';
import { DEFAULT_SOCKET_GUARD, type SocketGuard } from '../../infrastructure/ws/socket-guard.js';
import { readHeaderOrigin, socketOriginDecision } from '../../infrastructure/ws/socket-origin.js';
import { readOpaqueCookie, SESSION_COOKIE } from '../auth/cookies.js';
import type { AuthContext } from '../auth/rbac.js';
import { PERMISSIONS } from '../auth/rbac.js';
import type { DistributionEvent, MarketDataEngine } from './engine.js';

export type SessionLoader = {
  loadSession(token: string | null): Promise<AuthContext | null>;
};

type MarketSocket = {
  bufferedAmount?: number;
  on(event: 'message', listener: (raw: Buffer | string) => void): void;
  on(event: 'close' | 'error', listener: () => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

type SocketEndpoint = {
  allowedOrigins: readonly string[];
  auth: SessionLoader;
  engine: MarketDataEngine;
  connections: ConnectionLimiter;
  guard: SocketGuard;
  sessionToken: string | null;
};

export function registerMarketDataSocket(
  app: FastifyInstance,
  config: Pick<AppConfig, 'corsOrigins'>,
  auth: SessionLoader,
  engine: MarketDataEngine,
  connections: ConnectionLimiter,
  guard: SocketGuard = DEFAULT_SOCKET_GUARD,
): void {
  app.get(
    '/ws/market-data',
    { websocket: true },
    (socket: MarketSocket, request: FastifyRequest) => {
      openMarketDataSocket(socket, request, {
        allowedOrigins: config.corsOrigins,
        auth,
        engine,
        connections,
        guard,
        sessionToken: readOpaqueCookie(request, SESSION_COOKIE),
      });
    },
  );
}

export function openMarketDataSocket(
  socket: MarketSocket,
  request: { ip: string; headers: unknown },
  endpoint: SocketEndpoint,
): void {
  const queued: (Buffer | string)[] = [];
  const symbols = new Set<string>();
  const messages = new MessageWindow(
    endpoint.guard.maxMessagesPerWindow,
    endpoint.guard.messageWindowMs,
  );
  let ready = false;
  let closed = false;
  let acquired = false;
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const ip = normalizeClientIp(request.ip) ?? 'invalid';
  const closedNow = (): boolean => closed;

  const stop = (): void => {
    if (!unsubscribe) return;
    unsubscribe();
    unsubscribe = null;
  };
  const finish = (): void => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    queued.length = 0;
    stop();
    if (acquired) {
      acquired = false;
      endpoint.connections.release(ip);
    }
  };
  const closeSocket = (code: number, reason: string): void => {
    finish();
    socket.close(code, reason);
  };

  socket.on('close', finish);
  socket.on('error', () => {
    closeSocket(1011, 'socket error');
  });

  const origin = socketOriginDecision(readHeaderOrigin(request.headers), endpoint.allowedOrigins);
  if (!origin.ok) {
    closeSocket(1008, origin.reason);
    return;
  }
  if (!endpoint.connections.tryAcquire(ip)) {
    closeSocket(1008, 'too many connections');
    return;
  }
  acquired = true;
  timer = setTimeout(() => {
    if (!ready) closeSocket(1008, 'authentication timeout');
  }, endpoint.guard.authTimeoutMs);
  timer.unref();

  const handle = (raw: Buffer | string): void => {
    if (closed) return;
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
        health: endpoint.engine.health(),
      }),
    );
  };

  socket.on('message', (raw) => {
    if (closed) return;
    const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
    if (size > endpoint.guard.maxPayloadBytes) {
      closeSocket(1009, 'message too big');
      return;
    }
    if (!messages.allow()) {
      closeSocket(1008, 'message rate exceeded');
      return;
    }
    if (!ready) {
      if (queued.length >= endpoint.guard.maxQueuedBeforeAuth) {
        closeSocket(1008, 'too many messages');
        return;
      }
      queued.push(raw);
      return;
    }
    handle(raw);
  });

  void endpoint.auth.loadSession(endpoint.sessionToken).then(
    (session) => {
      if (closed) return;
      if (
        !session ||
        session.emailVerifiedAt === null ||
        !session.permissions.has(PERMISSIONS.marketDataRead)
      ) {
        closeSocket(1008, 'sign in required');
        return;
      }
      clearTimeout(timer);
      unsubscribe = endpoint.engine.subscribe((event) => {
        if (closedNow()) return;
        if ((socket.bufferedAmount ?? 0) > endpoint.guard.slowConsumerBytes) {
          closeSocket(1008, 'slow consumer');
          return;
        }
        if (event.type === 'quote' && !symbols.has(event.quote.symbol)) return;
        if (event.type === 'trade' && !symbols.has(event.trade.symbol)) return;
        if (event.type === 'gap' && !symbols.has(event.symbol)) return;
        try {
          socket.send(JSON.stringify(outbound(event)));
        } catch {
          closeSocket(1011, 'send failed');
        }
      });
      if (closedNow()) {
        stop();
        return;
      }
      ready = true;
      const pending = queued.splice(0, queued.length);
      for (const raw of pending) {
        if (closedNow()) return;
        handle(raw);
      }
    },
    () => {
      if (!closed) closeSocket(1011, 'authentication failed');
    },
  );
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
