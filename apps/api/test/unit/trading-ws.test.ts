import { describe, expect, it } from 'vitest';

import { ConnectionLimiter } from '../../src/infrastructure/ws/connection-limits.js';
import { DEFAULT_SOCKET_GUARD } from '../../src/infrastructure/ws/socket-guard.js';
import type { AuthContext } from '../../src/modules/auth/rbac.js';
import { PERMISSIONS } from '../../src/modules/auth/rbac.js';
import { TradingFanout } from '../../src/modules/trading/trading-fanout.js';
import { openTradingSocket } from '../../src/modules/trading/trading-ws.js';

const origin = 'http://127.0.0.1:3000';

class FakeSocket {
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private closeListener: (() => void) | null = null;
  private messageListener: ((raw: Buffer | string) => void) | null = null;

  on(event: 'message', listener: (raw: Buffer | string) => void): void;
  on(event: 'close' | 'error', listener: () => void): void;
  on(
    event: 'message' | 'close' | 'error',
    listener: ((raw: Buffer | string) => void) | (() => void),
  ): void {
    if (event === 'message') this.messageListener = listener;
    else if (event === 'close') this.closeListener = listener as () => void;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.closeListener?.();
  }

  emit(raw: string): void {
    this.messageListener?.(raw);
  }
}

function session(userId: string): AuthContext {
  return {
    userId,
    sessionId: '00000000-0000-4000-8000-000000000011',
    email: `${userId}@example.com`,
    displayName: 'Ada',
    status: 'ACTIVE',
    emailVerifiedAt: '2026-11-21T00:00:00.000Z',
    createdAt: '2026-11-21T00:00:00.000Z',
    roles: ['TRADER'],
    permissions: new Set([PERMISSIONS.tradingRead]),
    staff: false,
    mfaEnrolled: false,
    mfaSatisfied: false,
    csrfHash: 'hash',
    expiresAt: '2026-11-22T00:00:00.000Z',
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe('trading socket events', () => {
  it('keeps each account event on that user socket', async () => {
    const fanout = new TradingFanout();
    const connections = new ConnectionLimiter();
    const userA = '00000000-0000-4000-8000-00000000000a';
    const userB = '00000000-0000-4000-8000-00000000000b';
    const socketA = open(fanout, connections, userA);
    const socketB = open(fanout, connections, userB);
    await flush();
    fanout.publish(userA, {
      type: 'order',
      accountId: '00000000-0000-4000-8000-0000000000aa',
    });
    fanout.publish(userA, {
      type: 'fill',
      accountId: '00000000-0000-4000-8000-0000000000aa',
    });
    fanout.publish(userB, {
      type: 'position',
      accountId: '00000000-0000-4000-8000-0000000000bb',
    });
    const eventsA = socketA.sent.slice(1).map((body) => JSON.parse(body) as { type: string });
    const eventsB = socketB.sent.slice(1).map((body) => JSON.parse(body) as { type: string });
    expect(eventsA.map((event) => event.type)).toEqual(['order', 'fill']);
    expect(eventsB.map((event) => event.type)).toEqual(['position']);
    expect(socketA.sent.join('')).not.toContain('0000000000bb');
    expect(socketB.sent.join('')).not.toContain('0000000000aa');
  });

  it('closes a missing session, a bad origin, and a user over the socket cap', async () => {
    const fanout = new TradingFanout(2);
    const connections = new ConnectionLimiter();
    const anonymous = new FakeSocket();
    openTradingSocket(anonymous, request(), {
      allowedOrigins: [origin],
      auth: { loadSession: () => Promise.resolve(null) },
      connections,
      guard: DEFAULT_SOCKET_GUARD,
      fanout,
      sessionToken: null,
    });
    await flush();
    expect(anonymous.closed).toEqual({ code: 1008, reason: 'sign in required' });

    const foreign = new FakeSocket();
    openTradingSocket(foreign, request('https://evil.example'), {
      allowedOrigins: [origin],
      auth: { loadSession: () => Promise.resolve(session('00000000-0000-4000-8000-00000000000c')) },
      connections: new ConnectionLimiter(),
      guard: DEFAULT_SOCKET_GUARD,
      fanout: new TradingFanout(),
      sessionToken: 'session',
    });
    expect(foreign.closed).toEqual({ code: 1008, reason: 'origin not allowed' });

    const user = '00000000-0000-4000-8000-00000000000d';
    const limited = new ConnectionLimiter();
    const first = open(fanout, limited, user);
    const second = open(fanout, limited, user);
    const third = open(fanout, limited, user);
    await flush();
    expect(first.closed).toBeNull();
    expect(second.closed).toBeNull();
    expect(third.closed).toEqual({ code: 1008, reason: 'too many connections' });
  });
});

function open(fanout: TradingFanout, connections: ConnectionLimiter, userId: string): FakeSocket {
  const socket = new FakeSocket();
  openTradingSocket(socket, request(), {
    allowedOrigins: [origin],
    auth: { loadSession: () => Promise.resolve(session(userId)) },
    connections,
    guard: DEFAULT_SOCKET_GUARD,
    fanout,
    sessionToken: 'session',
  });
  return socket;
}

function request(header = origin): { url: string; ip: string; headers: { origin: string } } {
  return { url: '/ws/trading', ip: '127.0.0.1', headers: { origin: header } };
}
