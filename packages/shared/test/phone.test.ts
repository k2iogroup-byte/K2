import { describe, expect, it } from 'vitest';

import { normalisePhone } from '../src/phone.js';

describe('international phone normalisation', () => {
  it('stores a consistent E.164 value', () => {
    expect(normalisePhone('+1 (415) 555-2671')).toBe('+14155552671');
    expect(normalisePhone('00442079460958')).toBe('+442079460958');
    expect(normalisePhone('+14155552671')).toBe('+14155552671');
  });

  it('rejects national numbers, letters, and values that are not E.164', () => {
    expect(normalisePhone('4155552671')).toBeNull();
    expect(normalisePhone('+1 415 555 2671 ext 9')).toBeNull();
    expect(normalisePhone('+123')).toBeNull();
    expect(normalisePhone('+0123456789')).toBeNull();
    expect(normalisePhone('+14155552671000000')).toBeNull();
  });
});
