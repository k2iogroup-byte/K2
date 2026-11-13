import { describe, expect, it } from 'vitest';

import { proxyTarget } from './api-proxy';

describe('API proxy target', () => {
  it('builds a same-origin API path and rejects queries and traversal', () => {
    expect(proxyTarget(['auth', 'login'], '', 'http://127.0.0.1:4000')).toBe(
      'http://127.0.0.1:4000/auth/login',
    );
    expect(proxyTarget(['auth', 'login'], '?token=secret', 'http://127.0.0.1:4000')).toBeNull();
    expect(proxyTarget(['..', 'etc'], '', 'http://127.0.0.1:4000')).toBeNull();
    expect(proxyTarget(['auth'], '', 'file:///tmp')).toBeNull();
  });
});
