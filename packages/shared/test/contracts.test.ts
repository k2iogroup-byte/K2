import { describe, expect, it } from 'vitest';

import { apiErrorSchema, healthResponseSchema, wsClientMessageSchema } from '../src/index.js';

const health = {
  status: 'ok',
  service: 'k2-api',
  version: '0.1.0',
  environment: 'development',
  checks: {
    database: { status: 'up', latencyMs: 3, schemaVersion: '0001' },
  },
  timestamp: '2026-11-13T00:00:00.000Z',
};

describe('shared contracts', () => {
  it('accepts a health payload and rejects unknown fields', () => {
    expect(healthResponseSchema.safeParse(health).success).toBe(true);
    expect(healthResponseSchema.safeParse({ ...health, password: 'secret' }).success).toBe(false);
  });

  it('accepts an API error body', () => {
    const parsed = apiErrorSchema.safeParse({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        requestId: 'req-1',
        details: [{ path: 'query', message: 'Invalid value' }],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts only a ping from websocket clients', () => {
    expect(wsClientMessageSchema.safeParse({ type: 'ping' }).success).toBe(true);
    expect(wsClientMessageSchema.safeParse({ type: 'subscribe', symbol: 'AAPL' }).success).toBe(
      false,
    );
  });
});
