import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { ConfigError, loadConfig } from '../../src/config/env.js';
import { migrationsDirectory } from '../../src/config/paths.js';
import { loadMigrations } from '../../src/infrastructure/db/migrator.js';
import type { DatabaseProbe } from '../../src/infrastructure/db/probe.js';
import { startServer } from '../../src/server.js';
import { validEnv } from '../valid-env.js';

function probe(overrides?: Partial<Awaited<ReturnType<DatabaseProbe['check']>>>): DatabaseProbe {
  return {
    check() {
      return Promise.resolve({
        reachable: true,
        migrated: true,
        latencyMs: 2,
        schemaVersion: '0001',
        ...overrides,
      });
    },
  };
}

describe('application startup and health', () => {
  it('refuses to start when configuration is invalid', async () => {
    await expect(
      startServer(validEnv({ PORT: 'nope' }) as NodeJS.ProcessEnv),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('serves health, security headers, and CORS from a started server', async () => {
    const config = loadConfig(validEnv());
    const app = await buildApp({ config, database: probe(), logger: false });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { origin: 'http://127.0.0.1:3000' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:3000');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      status: 'ok',
      checks: { database: { status: 'up', schemaVersion: '0001' } },
    });
    expect(JSON.stringify(body)).not.toContain('local-dev-password-value');

    const denied = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();

    const invalid = await fetch(`http://127.0.0.1:${port}/health?token=super-secret-value`);
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain('super-secret-value');

    const missing = await fetch(`http://127.0.0.1:${port}/no-such-route`);
    expect(missing.status).toBe(404);

    const oversized = await fetch(`http://127.0.0.1:${port}/health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(20_000),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.text()).not.toContain('xxxxx');
    await app.close();
  });

  it('reports degraded health when the database is down or unmigrated', async () => {
    const config = loadConfig(validEnv());
    const down = await buildApp({
      config,
      database: probe({ reachable: false, migrated: false, schemaVersion: null, latencyMs: 4 }),
      logger: false,
    });
    const downResponse = await down.inject({ method: 'GET', url: '/health' });
    expect(downResponse.statusCode).toBe(503);
    expect(downResponse.json()).toMatchObject({
      status: 'degraded',
      checks: { database: { status: 'down' } },
    });
    await down.close();

    const unmigrated = await buildApp({
      config,
      database: probe({ reachable: true, migrated: false, schemaVersion: null }),
      logger: false,
    });
    const unmigratedResponse = await unmigrated.inject({ method: 'GET', url: '/health' });
    expect(unmigratedResponse.statusCode).toBe(503);
    expect(unmigratedResponse.json()).toMatchObject({
      status: 'degraded',
      checks: { database: { status: 'up', schemaVersion: null } },
    });
    await unmigrated.close();
  });
});

describe('websocket infrastructure', () => {
  it('answers ping and rejects any other message', async () => {
    const config = loadConfig(validEnv());
    const app = await buildApp({ config, database: probe(), logger: false });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages = await new Promise<string[]>((resolve, reject) => {
      const received: string[] = [];
      const timer = setTimeout(() => {
        reject(new Error('websocket timed out'));
      }, 5_000);
      socket.addEventListener('message', (event) => {
        received.push(String(event.data));
        if (received.length === 2) {
          clearTimeout(timer);
          resolve(received);
        }
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('websocket failed'));
      });
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'ping' }));
        socket.send(JSON.stringify({ type: 'subscribe', symbol: 'AAPL' }));
      });
    });
    expect(JSON.parse(messages[0] ?? '{}')).toMatchObject({ type: 'pong' });
    expect(JSON.parse(messages[1] ?? '{}')).toMatchObject({
      type: 'error',
      code: 'VALIDATION_ERROR',
    });
    socket.close();
    await app.close();
  });
});

describe('migration files', () => {
  it('loads the foundation pair and rejects a one-sided migration', () => {
    const migrations = loadMigrations(migrationsDirectory());
    expect(migrations.map((migration) => migration.version)).toEqual(['0001']);
    const dir = mkdtempSync(path.join(tmpdir(), 'k2-mig-'));
    writeFileSync(path.join(dir, '0001_only.up.sql'), 'SELECT 1;');
    expect(() => loadMigrations(dir)).toThrow(/missing an up or down file/);
  });
});
