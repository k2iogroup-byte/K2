import { DecimalError } from '@k2/shared';
import { describe, expect, it } from 'vitest';

import {
  quotePriceToUsd,
  settlesAsUsd,
  USDT_USD_RATE,
} from '../../src/modules/trading/usdt-usd.js';

describe('USDT to USD', () => {
  it('maps USDT to USD at the exact 1:1 rate', () => {
    expect(USDT_USD_RATE).toBe('1');
    expect(quotePriceToUsd('USDT', '10.00', 2)).toBe('10.00');
    expect(quotePriceToUsd('USDT', '0.00000123', 8)).toBe('0.00000123');
    expect(quotePriceToUsd('USDT', '100000', 0)).toBe('100000');
    expect(quotePriceToUsd('USD', '12.50', 2)).toBe('12.50');
    expect(settlesAsUsd('USDT')).toBe(true);
    expect(settlesAsUsd('USD')).toBe(true);
    expect(settlesAsUsd('EUR')).toBe(false);
    expect(() => quotePriceToUsd('EUR', '1.00', 2)).toThrow(DecimalError);
  });
});
