import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import type { DatabaseProbe } from '../../src/infrastructure/db/probe.js';
import { ConnectionLimiter } from '../../src/infrastructure/ws/connection-limits.js';
import {
  DEFAULT_SOCKET_GUARD,
  type SocketGuard,
} from '../../src/infrastructure/ws/socket-guard.js';
import type { AuthContext } from '../../src/modules/auth/rbac.js';
import { PERMISSIONS } from '../../src/modules/auth/rbac.js';
import { MarketDataEngine } from '../../src/modules/market-data/engine.js';
import { openMarketDataSocket } from '../../src/modules/market-data/market-data-ws.js';
import { validEnv } from '../valid-env.js';

const origin = 'http://127.0.0.1:3000';
const equity = {
  id: '00000000-0000-4000-8000-000000000001',
  market: 'EQUITIES' as const,
  venue: 'NASDAQ' as const,
  symbol: 'TEST',
  providerSymbol: 'test',
  priceScale: 2,
  quantityScale: 0,
};

class FakeSocket {
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private messageListener: ((raw: Buffer | string) => void) | null = null;
  private closeListener: (() => void) | null = null;
  private errorListener: (() => void) | null = null;

  on(event: 'message', listener: (raw: Buffer | string) => void): void;
  on(event: 'close' | 'error', listener: () => void): void;
  on(
    event: 'message' | 'close' | 'error',
    listener: ((raw: Buffer | string) => void) | (() => void),
  ): void {
    if (event === 'message') this.messageListener = listener;
    else if (event === 'close') this.closeListener = listener as () => void;
    else this.errorListener = listener as () => void;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.closeListener?.();
  }

  emitMessage(raw: string): void {
    this.messageListener?.(raw);
  }

  fail(): void {
    this.errorListener?.();
  }

  types(): string[] {
    return this.sent.map((body) => {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
        const value = parsed.type;
        return typeof value === 'string' ? value : '';
      }
      return '';
    });
  }
}

function session(overrides?: Partial<AuthContext>): AuthContext {
  return {
    userId: '00000000-0000-4000-8000-000000000010',
    sessionId: '00000000-0000-4000-8000-000000000011',
    email: 'ada@example.com',
    displayName: 'Ada',
    status: 'ACTIVE',
    emailVerifiedAt: '2026-11-13T00:00:00.000Z',
    createdAt: '2026-11-13T00:00:00.000Z',
    roles: ['TRADER'],
    permissions: new Set([PERMISSIONS.marketDataRead]),
    staff: false,
    mfaEnrolled: false,
    mfaSatisfied: false,
    csrfHash: 'hash',
    expiresAt: '2026-11-14T00:00:00.000Z',
    ...overrides,
  };
}

function engine(): MarketDataEngine {
  return new MarketDataEngine({ providerId: 'test-fixture', priceOrigin: 'TEST_FIXTURE' }, [
    equity,
  ]);
}

async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function attach(
  socket: FakeSocket,
  market: MarketDataEngine,
  auth: { loadSession: (token: string | null) => Promise<AuthContext | null> },
  connections: ConnectionLimiter,
  guard: SocketGuard = { ...DEFAULT_SOCKET_GUARD, authTimeoutMs: 60_000 },
  ip = '203.0.113.10',
): void {
  openMarketDataSocket(
    socket,
    { ip, headers: { origin } },
    {
      allowedOrigins: [origin],
      auth,
      engine: market,
      connections,
      guard,
      sessionToken: 'session-token',
    },
  );
}

describe('market data websocket', () => {
  it('authenticates, then fans out to more than one consumer', async () => {
    const market = engine();
    const connections = new ConnectionLimiter(10, 10);
    const auth = { loadSession: () => Promise.resolve(session()) };
    const first = new FakeSocket();
    const second = new FakeSocket();
    attach(first, market, auth, connections, undefined, '203.0.113.10');
    attach(second, market, auth, connections, undefined, '203.0.113.11');
    await flush();
    first.emitMessage(JSON.stringify({ type: 'subscribe', symbols: ['TEST'] }));
    second.emitMessage(JSON.stringify({ type: 'subscribe', symbols: ['TEST'] }));
    await market.ingest(
      {
        kind: 'quote',
        providerEventId: 'q-1',
        providerSymbol: 'test',
        bid: '10.00',
        ask: '10.10',
        bidSize: '1',
        askSize: '1',
        last: null,
        sourceTimestamp: '2026-11-13T15:00:00.000Z',
        sequence: 1,
      },
      new Date('2026-11-13T15:00:00.000Z'),
    );
    expect(first.types()).toContain('quote');
    expect(second.types()).toContain('quote');
    expect(first.sent.every((body) => !body.includes('"liveMarketData":true'))).toBe(true);
  });

  it('closes when authentication fails or the database rejects the lookup', async () => {
    const market = engine();
    const connections = new ConnectionLimiter(10, 10);
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', onUnhandled);
    const denied = new FakeSocket();
    attach(denied, market, { loadSession: () => Promise.resolve(null) }, connections);
    await flush();
    expect(denied.closed).toEqual({ code: 1008, reason: 'sign in required' });

    const unverified = new FakeSocket();
    attach(
      unverified,
      market,
      { loadSession: () => Promise.resolve(session({ emailVerifiedAt: null })) },
      connections,
      undefined,
      '203.0.113.12',
    );
    await flush();
    expect(unverified.closed?.reason).toBe('sign in required');

    const forbidden = new FakeSocket();
    attach(
      forbidden,
      market,
      { loadSession: () => Promise.resolve(session({ permissions: new Set() })) },
      connections,
      undefined,
      '203.0.113.13',
    );
    await flush();
    expect(forbidden.closed?.reason).toBe('sign in required');

    const broken = new FakeSocket();
    attach(
      broken,
      market,
      { loadSession: () => Promise.reject(new Error('database unavailable')) },
      connections,
      undefined,
      '203.0.113.14',
    );
    await flush();
    expect(broken.closed).toEqual({ code: 1011, reason: 'authentication failed' });
    await flush();
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it('limits messages received before authentication and discards them on failure', async () => {
    const market = engine();
    const connections = new ConnectionLimiter(10, 10);
    let resolveSession: (value: AuthContext | null) => void = () => undefined;
    const socket = new FakeSocket();
    attach(
      socket,
      market,
      {
        loadSession: () =>
          new Promise((resolve) => {
            resolveSession = resolve;
          }),
      },
      connections,
    );
    for (let count = 0; count < DEFAULT_SOCKET_GUARD.maxQueuedBeforeAuth; count += 1) {
      socket.emitMessage(JSON.stringify({ type: 'ping' }));
    }
    expect(socket.closed).toBeNull();
    socket.emitMessage(JSON.stringify({ type: 'ping' }));
    expect(socket.closed).toEqual({ code: 1008, reason: 'too many messages' });
    resolveSession(session());
    await flush();
    expect(socket.types()).not.toContain('pong');
    expect(socket.types()).not.toContain('subscribed');
  });

  it('closes on an oversized payload, a message flood, and a slow consumer without blocking the other', async () => {
    const market = engine();
    const connections = new ConnectionLimiter(10, 10);
    const auth = { loadSession: () => Promise.resolve(session()) };
    const oversized = new FakeSocket();
    attach(oversized, market, auth, connections);
    oversized.emitMessage('x'.repeat(DEFAULT_SOCKET_GUARD.maxPayloadBytes + 1));
    expect(oversized.closed).toEqual({ code: 1009, reason: 'message too big' });

    const flooded = new FakeSocket();
    attach(flooded, market, auth, connections, undefined, '203.0.113.15');
    await flush();
    for (let count = 0; count < DEFAULT_SOCKET_GUARD.maxMessagesPerWindow; count += 1) {
      flooded.emitMessage(JSON.stringify({ type: 'ping' }));
    }
    expect(flooded.closed).toBeNull();
    flooded.emitMessage(JSON.stringify({ type: 'ping' }));
    expect(flooded.closed).toEqual({ code: 1008, reason: 'message rate exceeded' });

    const slow = new FakeSocket();
    const fast = new FakeSocket();
    attach(slow, market, auth, connections, undefined, '203.0.113.16');
    attach(fast, market, auth, connections, undefined, '203.0.113.17');
    await flush();
    slow.emitMessage(JSON.stringify({ type: 'subscribe', symbols: ['TEST'] }));
    fast.emitMessage(JSON.stringify({ type: 'subscribe', symbols: ['TEST'] }));
    slow.bufferedAmount = DEFAULT_SOCKET_GUARD.slowConsumerBytes + 1;
    const before = fast.sent.length;
    await market.ingest(
      {
        kind: 'quote',
        providerEventId: 'q-slow',
        providerSymbol: 'test',
        bid: '10.00',
        ask: '10.10',
        bidSize: '1',
        askSize: '1',
        last: null,
        sourceTimestamp: '2026-11-13T15:00:01.000Z',
        sequence: 1,
      },
      new Date('2026-11-13T15:00:01.000Z'),
    );
    expect(slow.closed).toEqual({ code: 1008, reason: 'slow consumer' });
    expect(fast.sent.length).toBeGreaterThan(before);
    expect(fast.types()).toContain('quote');
    expect(slow.types()).not.toContain('quote');
  });

  it('releases a closed socket so a later connection can subscribe again', async () => {
    const market = engine();
    const connections = new ConnectionLimiter(10, 1);
    const auth = { loadSession: () => Promise.resolve(session()) };
    const first = new FakeSocket();
    attach(first, market, auth, connections);
    await flush();
    first.emitMessage(JSON.stringify({ type: 'subscribe', symbols: ['TEST'] }));
    const sentBeforeClose = first.sent.length;
    first.close(1000, 'client');
    await market.ingest(
      {
        kind: 'quote',
        providerEventId: 'q-after-close',
        providerSymbol: 'test',
        bid: '10.00',
        ask: '10.10',
        bidSize: '1',
        askSize: '1',
        last: null,
        sourceTimestamp: '2026-11-13T15:00:02.000Z',
        sequence: 1,
      },
      new Date('2026-11-13T15:00:02.000Z'),
    );
    expect(first.sent.length).toBe(sentBeforeClose);

    const again = new FakeSocket();
    attach(again, market, auth, connections);
    await flush();
    again.emitMessage(JSON.stringify({ type: 'subscribe', symbols: ['TEST'] }));
    await market.ingest(
      {
        kind: 'quote',
        providerEventId: 'q-reconnect',
        providerSymbol: 'test',
        bid: '11.00',
        ask: '11.10',
        bidSize: '1',
        askSize: '1',
        last: null,
        sourceTimestamp: '2026-11-13T15:00:03.000Z',
        sequence: 2,
      },
      new Date('2026-11-13T15:00:03.000Z'),
    );
    expect(again.types()).toContain('quote');
    expect(first.sent.length).toBe(sentBeforeClose);
  });

  it('rejects a missing origin, a foreign origin, and a connection flood per address', () => {
    const market = engine();
    const connections = new ConnectionLimiter(10, 1);
    const missing = new FakeSocket();
    openMarketDataSocket(
      missing,
      { ip: '203.0.113.10', headers: {} },
      {
        allowedOrigins: [origin],
        auth: { loadSession: () => Promise.resolve(session()) },
        engine: market,
        connections,
        guard: DEFAULT_SOCKET_GUARD,
        sessionToken: 'session-token',
      },
    );
    expect(missing.closed).toEqual({ code: 1008, reason: 'origin required' });

    const foreign = new FakeSocket();
    openMarketDataSocket(
      foreign,
      { ip: '203.0.113.10', headers: { origin: 'https://evil.example' } },
      {
        allowedOrigins: [origin],
        auth: { loadSession: () => Promise.resolve(session()) },
        engine: market,
        connections,
        guard: DEFAULT_SOCKET_GUARD,
        sessionToken: 'session-token',
      },
    );
    expect(foreign.closed).toEqual({ code: 1008, reason: 'origin not allowed' });

    const held = new FakeSocket();
    const blocked = new FakeSocket();
    const auth = { loadSession: () => Promise.resolve(session()) };
    attach(held, market, auth, connections, undefined, '198.51.100.8');
    attach(blocked, market, auth, connections, undefined, '198.51.100.8');
    expect(blocked.closed).toEqual({ code: 1008, reason: 'too many connections' });
    const other = new FakeSocket();
    attach(other, market, auth, connections, undefined, '198.51.100.9');
    expect(other.closed).toBeNull();
    held.fail();
    const resumed = new FakeSocket();
    attach(resumed, market, auth, connections, undefined, '198.51.100.8');
    expect(resumed.closed).toBeNull();
  });

  it('times out a handshake that never finishes authentication', async () => {
    const socket = new FakeSocket();
    attach(
      socket,
      engine(),
      { loadSession: () => new Promise(() => undefined) },
      new ConnectionLimiter(10, 10),
      { ...DEFAULT_SOCKET_GUARD, authTimeoutMs: 20 },
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(socket.closed).toEqual({ code: 1008, reason: 'authentication timeout' });
  });
});

describe('websocket server limits', () => {
  function probe(): DatabaseProbe {
    return {
      check: () =>
        Promise.resolve({ reachable: true, migrated: true, latencyMs: 1, schemaVersion: '0001' }),
    };
  }

  it('drops an oversized frame and a third socket from the same address', async () => {
    const config = loadConfig(validEnv());
    const app = await buildApp({
      config,
      database: probe(),
      logger: false,
      connections: new ConnectionLimiter(4, 2),
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const url = `ws://127.0.0.1:${port}/ws`;
    const headers = { origin };
    const oversized = new WebSocket(url, { headers });
    const oversizedClose = closed(oversized);
    await opened(oversized);
    oversized.send('x'.repeat(DEFAULT_SOCKET_GUARD.maxPayloadBytes + 1));
    expect(await oversizedClose).toMatchObject({ code: 1009 });

    const first = new WebSocket(url, { headers });
    const second = new WebSocket(url, { headers });
    await opened(first);
    await opened(second);
    const third = new WebSocket(url, { headers });
    expect(await closed(third)).toEqual({ code: 1008, reason: 'too many connections' });
    first.close();
    second.close();
    await app.close();
  });
});

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => {
      resolve();
    });
    socket.once('error', () => {
      reject(new Error('websocket failed to open'));
    });
  });
}

function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => {
      resolve({ code, reason: String(reason) });
    });
  });
}
