import { describe, expect, it } from 'vitest';

import {
  absoluteMoneyDifference,
  canonicalMoney,
  mismatchSeverity,
  negateMoney,
} from '../../src/modules/ledger/money.js';

describe('ledger money', () => {
  it('keeps a signed scale-4 amount and flips it', () => {
    expect(canonicalMoney('10')).toBe('10.0000');
    expect(canonicalMoney('-10.5')).toBe('-10.5000');
    expect(negateMoney('10.0000')).toBe('-10.0000');
    expect(negateMoney('-0.0500')).toBe('0.0500');
    expect(absoluteMoneyDifference('10000.0000', '9989.9500')).toBe('10.0500');
  });

  it('treats an exact mismatch as critical until bands are supplied', () => {
    expect(mismatchSeverity('10.0000', '9.0000')).toBe('CRITICAL');
    expect(
      mismatchSeverity('10.0000', '9.5000', { warningAbs: '0.1000', criticalAbs: '1.0000' }),
    ).toBe('WARNING');
    expect(
      mismatchSeverity('10.0000', '8.0000', { warningAbs: '0.1000', criticalAbs: '1.0000' }),
    ).toBe('CRITICAL');
    expect(
      mismatchSeverity('10.0000', '9.9500', { warningAbs: '0.1000', criticalAbs: '1.0000' }),
    ).toBe('INFO');
  });
});
