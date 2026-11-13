import { afterEach, describe, expect, it } from 'vitest';

import { GET } from '../app/k2-api/[...path]/route';

const originalFetch = globalThis.fetch;
const originalDestination = process.env.API_PROXY_DESTINATION;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDestination === undefined) delete process.env.API_PROXY_DESTINATION;
  else process.env.API_PROXY_DESTINATION = originalDestination;
});

describe('API proxy route', () => {
  it('forwards the market-data query, auth headers, and upstream errors', async () => {
    process.env.API_PROXY_DESTINATION = 'http://127.0.0.1:4000';
    let seenUrl = '';
    let seenCookie = '';
    let seenMarker = '';
    let seenCsrf = '';
    globalThis.fetch = (input, init) => {
      seenUrl = requestUrl(input);
      const headers = new Headers(init?.headers);
      seenCookie = headers.get('cookie') ?? '';
      seenMarker = headers.get('x-k2-request') ?? '';
      seenCsrf = headers.get('x-csrf-token') ?? '';
      return Promise.resolve(
        new Response('no', {
          status: 401,
          headers: {
            'content-type': 'text/plain',
            'set-cookie': 'k2_session=abc; HttpOnly',
            'retry-after': '3',
          },
        }),
      );
    };

    const response = await GET(marketRequest('?symbol=BTC-USDT&timeframe=1m'), marketContext());
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('no');
    expect(seenUrl).toBe('http://127.0.0.1:4000/market-data/bars?symbol=BTC-USDT&timeframe=1m');
    expect(seenCookie).toBe('k2_session=abc');
    expect(seenMarker).toBe('1');
    expect(seenCsrf).toBe('csrf-token');
    expect(response.headers.get('set-cookie')).toContain('k2_session=abc');
    expect(response.headers.get('retry-after')).toBe('3');
  });

  it('preserves repeated parameters and returns 404 or 502 for a bad target or outage', async () => {
    process.env.API_PROXY_DESTINATION = 'http://127.0.0.1:4000/';
    let seenUrl = '';
    globalThis.fetch = (input) => {
      seenUrl = requestUrl(input);
      return Promise.resolve(
        new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    };
    const ok = await GET(
      new Request('http://web.local/k2-api/market-data/bars?symbol=BTC%2FUSDT&symbol=ETH-USDT'),
      { params: Promise.resolve({ path: ['market-data', 'bars'] }) },
    );
    expect(ok.status).toBe(200);
    expect(seenUrl).toBe(
      'http://127.0.0.1:4000/market-data/bars?symbol=BTC%2FUSDT&symbol=ETH-USDT',
    );

    const denied = await GET(new Request('http://web.local/k2-api/../etc'), {
      params: Promise.resolve({ path: ['..', 'etc'] }),
    });
    expect(denied.status).toBe(404);

    globalThis.fetch = () => Promise.reject(new Error('down'));
    const down = await GET(marketRequest(''), marketContext());
    expect(down.status).toBe(502);
    expect(await down.text()).toBe('The API is unavailable');
  });
});

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function marketRequest(search: string): Request {
  return new Request(`http://web.local/k2-api/market-data/bars${search}`, {
    headers: {
      cookie: 'k2_session=abc',
      'x-k2-request': '1',
      'x-csrf-token': 'csrf-token',
    },
  });
}

function marketContext(): { params: Promise<{ path: string[] }> } {
  return { params: Promise.resolve({ path: ['market-data', 'bars'] }) };
}
