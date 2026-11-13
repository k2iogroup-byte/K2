import { describe, expect, it } from 'vitest';

import { readApiBaseUrl } from './api-base-url';

describe('readApiBaseUrl', () => {
  it('returns the origin and drops a path', () => {
    expect(readApiBaseUrl('http://127.0.0.1:4000/health')).toEqual({
      ok: true,
      baseUrl: 'http://127.0.0.1:4000',
    });
  });

  it('rejects a missing value, a bad scheme, and embedded credentials', () => {
    expect(readApiBaseUrl(undefined).ok).toBe(false);
    expect(readApiBaseUrl('ftp://example.com').ok).toBe(false);
    expect(readApiBaseUrl('http://user:secret@127.0.0.1:4000').ok).toBe(false);
  });
});
