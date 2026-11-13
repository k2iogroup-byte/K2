import { describe, expect, it } from 'vitest';

import { proxyTarget } from './api-proxy';

const destination = 'http://127.0.0.1:4000';

describe('API proxy target', () => {
  it('forwards a market-data query and keeps the configured origin', () => {
    expect(proxyTarget(['market-data', 'bars'], '?symbol=BTC-USDT&timeframe=1m', destination)).toBe(
      'http://127.0.0.1:4000/market-data/bars?symbol=BTC-USDT&timeframe=1m',
    );
    expect(
      proxyTarget(['market-data', 'bars'], '?symbol=BTC-USDT&timeframe=1m&limit=2', destination),
    ).toBe('http://127.0.0.1:4000/market-data/bars?symbol=BTC-USDT&timeframe=1m&limit=2');
  });

  it('preserves encoded values and repeated parameters', () => {
    expect(
      proxyTarget(['market-data', 'bars'], '?symbol=BTC%2FUSDT&timeframe=1m', destination),
    ).toBe('http://127.0.0.1:4000/market-data/bars?symbol=BTC%2FUSDT&timeframe=1m');
    expect(proxyTarget(['search'], '?q=a%20b&q=c', destination)).toBe(
      'http://127.0.0.1:4000/search?q=a%20b&q=c',
    );
  });

  it('rejects traversal, other schemes, and a destination that is not an origin', () => {
    expect(proxyTarget(['..', 'etc'], '', destination)).toBeNull();
    expect(proxyTarget(['market-data', '..'], '?symbol=BTC-USDT', destination)).toBeNull();
    expect(proxyTarget(['auth'], '', 'file:///tmp')).toBeNull();
    expect(proxyTarget(['auth', 'login'], '', 'http://user:secret@127.0.0.1:4000')).toBeNull();
    expect(proxyTarget(['auth', 'login'], '', 'http://127.0.0.1:4000/internal')).toBeNull();
    expect(proxyTarget([], '', destination)).toBeNull();
  });

  it('rejects malicious query strings', () => {
    expect(
      proxyTarget(['market-data', 'bars'], '?symbol=../../etc/passwd', destination),
    ).toBeNull();
    expect(proxyTarget(['market-data', 'bars'], '?next=%2e%2e%2fetc', destination)).toBeNull();
    expect(proxyTarget(['market-data', 'bars'], '?q=%00', destination)).toBeNull();
    expect(proxyTarget(['market-data', 'bars'], '?q=a b', destination)).toBeNull();
    expect(proxyTarget(['market-data', 'bars'], `?q=${'a'.repeat(3_000)}`, destination)).toBeNull();
    expect(
      proxyTarget(['market-data', 'bars'], '?next=http://evil.example/%0d%0a', destination),
    ).toBeNull();
  });
});
