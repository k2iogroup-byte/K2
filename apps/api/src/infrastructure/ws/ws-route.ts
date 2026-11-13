import websocket from '@fastify/websocket';
import { wsClientMessageSchema, type WsServerMessage } from '@k2/shared';
import type { FastifyInstance } from 'fastify';

import type { AppConfig } from '../../config/env.js';
import { isAllowedOrigin } from '../http/origin.js';

type WsMessageHandler = {
  on(event: 'message', listener: (raw: Buffer | string) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export async function registerWebSocket(
  app: FastifyInstance,
  config: Pick<AppConfig, 'corsOrigins'>,
): Promise<void> {
  await app.register(websocket);
  app.get('/ws', { websocket: true }, (socket: WsMessageHandler, request) => {
    const origin = readOrigin(request.headers);
    if (!isAllowedOrigin(origin, config.corsOrigins)) {
      socket.close(1008, 'origin not allowed');
      return;
    }
    socket.on('message', (raw) => {
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
