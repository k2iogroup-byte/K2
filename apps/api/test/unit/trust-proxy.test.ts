import { describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import type { DatabaseProbe } from '../../src/infrastructure/db/probe.js';
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
});
