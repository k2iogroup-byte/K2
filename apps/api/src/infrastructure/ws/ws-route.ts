import websocket from '@fastify/websocket';
import { wsClientMessageSchema, type WsServerMessage } from '@k2/shared';
import type { FastifyInstance } from 'fastify';

import type { AppConfig } from '../../config/env.js';
import { normalizeClientIp } from '../http/client-ip.js';
import type { ConnectionLimiter } from './connection-limits.js';
import { MessageWindow } from './connection-limits.js';
import { DEFAULT_SOCKET_GUARD } from './socket-guard.js';
import { readHeaderOrigin, socketOriginDecision } from './socket-origin.js';

type WsMessageHandler = {
  on(event: 'message', listener: (raw: Buffer | string) => void): void;
  on(event: 'close' | 'error', listener: () => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export async function registerWebSocket(
  app: FastifyInstance,
  config: Pick<AppConfig, 'corsOrigins'>,
  connections: ConnectionLimiter,
): Promise<void> {
  await app.register(websocket, {
    options: { maxPayload: DEFAULT_SOCKET_GUARD.maxPayloadBytes },
  });
  app.get('/ws', { websocket: true }, (socket: WsMessageHandler, request) => {
    let closed = false;
    let acquired = false;
    const ip = normalizeClientIp(request.ip) ?? 'invalid';
    const messages = new MessageWindow(
      DEFAULT_SOCKET_GUARD.maxMessagesPerWindow,
      DEFAULT_SOCKET_GUARD.messageWindowMs,
    );
    const finish = (): void => {
      if (closed) return;
      closed = true;
      if (acquired) {
        acquired = false;
        connections.release(ip);
      }
    };
    socket.on('close', finish);
    socket.on('error', () => {
      finish();
      socket.close(1011, 'socket error');
    });
    const origin = socketOriginDecision(readHeaderOrigin(request.headers), config.corsOrigins);
    if (!origin.ok) {
      socket.close(1008, origin.reason);
      return;
    }
    if (!connections.tryAcquire(ip)) {
      socket.close(1008, 'too many connections');
      return;
    }
    acquired = true;
    socket.on('message', (raw) => {
      if (closed) return;
      const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
      if (size > DEFAULT_SOCKET_GUARD.maxPayloadBytes) {
        socket.close(1009, 'message too big');
        finish();
        return;
      }
      if (!messages.allow()) {
        socket.close(1008, 'message rate exceeded');
        finish();
        return;
      }
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      let payload: unknown;
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        send(socket, { type: 'error', code: 'VALIDATION_ERROR', message: 'Invalid JSON' });
        return;
      }
      const parsed = wsClientMessageSchema.safeParse(payload);
      if (!parsed.success) {
        send(socket, { type: 'error', code: 'VALIDATION_ERROR', message: 'Unsupported message' });
        return;
      }
      send(socket, { type: 'pong', timestamp: new Date().toISOString() });
    });
  });
}

function send(socket: WsMessageHandler, message: WsServerMessage): void {
  socket.send(JSON.stringify(message));
}
