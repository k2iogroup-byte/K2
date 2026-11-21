import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AppConfig } from '../../config/env.js';
import { normalizeClientIp } from '../../infrastructure/http/client-ip.js';
import type { ConnectionLimiter } from '../../infrastructure/ws/connection-limits.js';
import { MessageWindow } from '../../infrastructure/ws/connection-limits.js';
import { DEFAULT_SOCKET_GUARD, type SocketGuard } from '../../infrastructure/ws/socket-guard.js';
import { readHeaderOrigin, socketOriginDecision } from '../../infrastructure/ws/socket-origin.js';
import { readOpaqueCookie, SESSION_COOKIE } from '../auth/cookies.js';
import { type AuthContext, PERMISSIONS } from '../auth/rbac.js';

type TradingSocket = {
  bufferedAmount?: number;
  on(event: 'message', listener: (raw: Buffer | string) => void): void;
  on(event: 'close' | 'error', listener: () => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

type SessionLoader = {
  loadSession(token: string | null): Promise<AuthContext | null>;
};

export function registerTradingSocket(
  app: FastifyInstance,
  config: Pick<AppConfig, 'corsOrigins'>,
  auth: SessionLoader,
  connections: ConnectionLimiter,
  guard: SocketGuard = DEFAULT_SOCKET_GUARD,
): void {
  app.get('/ws/trading', { websocket: true }, (socket: TradingSocket, request: FastifyRequest) => {
    openTradingSocket(socket, request, {
      allowedOrigins: config.corsOrigins,
      auth,
      connections,
      guard,
      sessionToken: readOpaqueCookie(request, SESSION_COOKIE),
    });
  });
}

export function openTradingSocket(
  socket: TradingSocket,
  request: FastifyRequest,
  endpoint: {
    allowedOrigins: readonly string[];
    auth: SessionLoader;
    connections: ConnectionLimiter;
    guard: SocketGuard;
    sessionToken: string | null;
  },
): void {
  let closed = false;
  let ready = false;
  let acquired = false;
  const messages = new MessageWindow(
    endpoint.guard.maxMessagesPerWindow,
    endpoint.guard.messageWindowMs,
  );
  const ip = normalizeClientIp(request.ip) ?? 'invalid';
  const finish = (): void => {
    if (closed) return;
    closed = true;
    if (acquired) endpoint.connections.release(ip);
  };
  const closeSocket = (code: number, reason: string): void => {
    finish();
    socket.close(code, reason);
  };
  socket.on('close', finish);
  socket.on('error', () => {
    closeSocket(1011, 'socket error');
  });
  if (request.url.includes('token=')) {
    closeSocket(1008, 'token in url');
    return;
  }
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
  const timer = setTimeout(() => {
    if (!ready) closeSocket(1008, 'authentication timeout');
  }, endpoint.guard.authTimeoutMs);
  timer.unref();
  socket.on('message', (raw) => {
    if (closed) return;
    const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
    if (size > endpoint.guard.maxPayloadBytes || !messages.allow()) {
      closeSocket(1008, 'message rejected');
      return;
    }
    if (!ready) return;
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    if (text.includes('"ping"')) {
      socket.send(
        JSON.stringify({
          type: 'pong',
          sequence: '0',
          liveMarketData: false,
          executionVenue: 'K2_SIMULATION',
        }),
      );
    }
  });
  void endpoint.auth.loadSession(endpoint.sessionToken).then(
    (session) => {
      if (closed) return;
      if (
        !session ||
        session.emailVerifiedAt === null ||
        !session.permissions.has(PERMISSIONS.tradingRead)
      ) {
        closeSocket(1008, 'sign in required');
        return;
      }
      clearTimeout(timer);
      ready = true;
      socket.send(
        JSON.stringify({
          type: 'ready',
          sequence: '0',
          liveMarketData: false,
          executionVenue: 'K2_SIMULATION',
        }),
      );
    },
    () => {
      if (!closed) closeSocket(1011, 'authentication failed');
    },
  );
}
