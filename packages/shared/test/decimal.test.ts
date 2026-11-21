import { describe, expect, it } from 'vitest';

import {
  canonicalDecimal,
  DecimalError,
  decimalsEqual,
  divideByInt,
  multiplyDecimals,
  subtractDecimals,
} from '../src/decimal.js';

describe('exact decimals', () => {
  it('canonicalises money without rounding and rejects non-zero extra digits', () => {
    expect(canonicalDecimal('129', 2)).toBe('129.00');
    expect(canonicalDecimal('129.00', 2)).toBe('129.00');
    expect(canonicalDecimal('129.0000', 2)).toBe('129.00');
    expect(canonicalDecimal('0.50', 4)).toBe('0.5000');
    expect(decimalsEqual('10000.00', '10000.0000', 4)).toBe(true);
    expect(() => canonicalDecimal('129.001', 2)).toThrow(DecimalError);
    expect(() => canonicalDecimal('1e2', 2)).toThrow(DecimalError);
    expect(() => canonicalDecimal('-1.00', 2)).toThrow(DecimalError);
    expect(() => canonicalDecimal('00.10', 2)).toThrow(DecimalError);
  });

  it('multiplies and divides money half away from zero', () => {
    expect(multiplyDecimals('10.00', '1', 2, 0, 4)).toBe('10.0000');
    expect(multiplyDecimals('10.0000', '0.5000', 4, 4, 4)).toBe('5.0000');
    expect(divideByInt('5.0000', 4, 100n, 4)).toBe('0.0500');
    expect(subtractDecimals('10.0000', '0.0500', 4)).toBe('9.9500');
    expect(subtractDecimals('0.50', '0.80', 2)).toBe('-0.30');
  });
});
