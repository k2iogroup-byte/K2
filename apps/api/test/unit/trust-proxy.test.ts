import { describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import type { DatabaseProbe } from '../../src/infrastructure/db/probe.js';
import { requestMeta } from '../../src/modules/auth/request-context.js';
import { validEnv } from '../valid-env.js';

function probe(): DatabaseProbe {
  return {
    check() {
      return Promise.resolve({
        reachable: true,
        migrated: true,
        latencyMs: 1,
        schemaVersion: '0001',
      });
    },
  };
}

async function clientIp(
  trustProxy: string | undefined,
  remoteAddress: string,
  forwardedFor?: string,
): Promise<string> {
  const config = loadConfig(validEnv(trustProxy === undefined ? {} : { TRUST_PROXY: trustProxy }));
  const app = await buildApp({ config, database: probe(), logger: false });
  app.get('/client-ip', (request) => ({ ip: request.ip }));
  const response = await app.inject({
    method: 'GET',
    url: '/client-ip',
    remoteAddress,
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  });
  await app.close();
  const body: unknown = response.json();
  if (typeof body !== 'object' || body === null || !('ip' in body) || typeof body.ip !== 'string') {
    throw new Error('client ip response was not an object');
  }
  return body.ip;
}

describe('TRUST_PROXY client address', () => {
  it('ignores X-Forwarded-For when unset', async () => {
    await expect(clientIp(undefined, '10.0.0.8', '203.0.113.9')).resolves.toBe('10.0.0.8');
  });

  it('uses the address added by one trusted hop and ignores a prepended spoof', async () => {
    await expect(clientIp('1', '10.0.0.8', '1.2.3.4, 203.0.113.9')).resolves.toBe('203.0.113.9');
  });

  it('keeps the proxy address when the forwarded header is absent', async () => {
    await expect(clientIp('1', '10.0.0.8')).resolves.toBe('10.0.0.8');
  });

  it('lets a direct client choose the address when only a hop count is configured', async () => {
    await expect(clientIp('1', '203.0.113.50', '1.2.3.4')).resolves.toBe('1.2.3.4');
  });

  it('does not let a second spoofed address through a one-hop setting', async () => {
    await expect(clientIp('2', '10.0.0.8', '1.2.3.4, 203.0.113.9')).resolves.toBe('1.2.3.4');
  });

  it('ignores forwarded headers from a peer outside the trusted CIDR', async () => {
    await expect(clientIp('10.0.0.0/8', '203.0.113.50', '1.2.3.4')).resolves.toBe('203.0.113.50');
    await expect(clientIp('10.0.0.0/8', '10.0.0.8', '1.2.3.4, 203.0.113.9')).resolves.toBe(
      '203.0.113.9',
    );
  });

  it('ignores a forged header on a direct connection, including IPv6', async () => {
    await expect(clientIp('false', '192.0.2.8', '203.0.113.9, 198.51.100.4')).resolves.toBe(
      '192.0.2.8',
    );
    await expect(clientIp(undefined, 'fd00::1', '2001:db8::9')).resolves.toBe('fd00::1');
    await expect(clientIp('0', '2001:db8::1', '2001:db8::9')).resolves.toBe('2001:db8::1');
  });

  it('reads IPv4 and IPv6 clients behind one trusted hop or CIDR', async () => {
    await expect(clientIp('1', 'fd00::1', '2001:db8::10')).resolves.toBe('2001:db8::10');
    await expect(clientIp('1', '10.0.0.8', '1.2.3.4,, 203.0.113.9')).resolves.toBe('203.0.113.9');
    await expect(clientIp('fd00::/8', 'fd00::8', '2001:db8::10')).resolves.toBe('2001:db8::10');
    await expect(clientIp('fd00::/8', '2001:db8::8', '198.51.100.9')).resolves.toBe('2001:db8::8');
  });

  it('keeps the peer address when the forwarding header is missing or blank', async () => {
    await expect(clientIp('1', '192.0.2.15', '')).resolves.toBe('192.0.2.15');
    await expect(clientIp('1', '192.0.2.15', '   ')).resolves.toBe('192.0.2.15');
    await expect(clientIp('10.0.0.0/8', '10.0.0.8')).resolves.toBe('10.0.0.8');
  });

  it('separates two clients behind one proxy and drops a non-IP from the rate-limit key', async () => {
    const config = loadConfig(validEnv({ TRUST_PROXY: '1' }));
    const app = await buildApp({ config, database: probe(), logger: false });
    app.get('/meta', (request) => requestMeta(request));
    const left = await app.inject({
      method: 'GET',
      url: '/meta',
      remoteAddress: '10.0.0.8',
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    const right = await app.inject({
      method: 'GET',
      url: '/meta',
      remoteAddress: '10.0.0.8',
      headers: { 'x-forwarded-for': '198.51.100.4, 203.0.113.11' },
    });
    const mapped = await app.inject({
      method: 'GET',
      url: '/meta',
      remoteAddress: '10.0.0.8',
      headers: { 'x-forwarded-for': '::ffff:203.0.113.20' },
    });
    const garbage = await app.inject({
      method: 'GET',
      url: '/meta',
      remoteAddress: '10.0.0.8',
      headers: { 'x-forwarded-for': 'not-an-ip' },
    });
    await app.close();
    expect(left.json()).toMatchObject({ ip: '203.0.113.10' });
    expect(right.json()).toMatchObject({ ip: '203.0.113.11' });
    expect(mapped.json()).toMatchObject({ ip: '203.0.113.20' });
    expect(garbage.json()).toMatchObject({ ip: null });
  });
});
