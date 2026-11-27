import { describe, expect, it } from 'vitest';

import { accountEquity } from '../../src/modules/trading/equity.js';

describe('account equity', () => {
  it('adds cash to open longs marked at the bid', () => {
    expect(
      accountEquity('89950.0000', [
        {
          quantity: '1000.00000',
          quantityScale: 5,
          bid: '10.50',
          priceScale: 2,
          quoteAsset: 'USD',
        },
      ]),
    ).toBe('100450.0000');
  });

  it('maps a USDT bid one to one and ignores a flat leg', () => {
    expect(
      accountEquity('100000.0000', [
        {
          quantity: '0.00000',
          quantityScale: 5,
          bid: '10.00',
          priceScale: 2,
          quoteAsset: 'USDT',
        },
        {
          quantity: '500.00000',
          quantityScale: 5,
          bid: '10.00000000',
          priceScale: 8,
          quoteAsset: 'USDT',
        },
      ]),
    ).toBe('105000.0000');
  });

  it('returns null when a mark or asset cannot be valued', () => {
    expect(
      accountEquity('100000.0000', [
        {
          quantity: '1.00000000',
          quantityScale: 8,
          bid: '10.00',
          priceScale: 2,
          quoteAsset: 'EUR',
        },
      ]),
    ).toBeNull();
    expect(accountEquity('nope', [])).toBeNull();
  });
});
