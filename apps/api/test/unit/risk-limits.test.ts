import { describe, expect, it } from 'vitest';

import {
  dailyLossFloor,
  drawdownFloor,
  equityBreaches,
  higherPrice,
  stressedEquity,
} from '../../src/modules/risk/limits.js';

describe('risk floors', () => {
  it('sets the daily floor from an intraday equity high of 105000', () => {
    expect(dailyLossFloor('105000.0000')).toBe('99750.0000');
    expect(dailyLossFloor('100000.0000')).toBe('95000.0000');
    expect(equityBreaches('99750.0000', '99750.0000')).toBe(true);
    expect(equityBreaches('99750.0001', '99750.0000')).toBe(false);
  });

  it('keeps max drawdown static at 92 percent of the initial balance', () => {
    expect(drawdownFloor('100000.0000')).toBe('92000.0000');
    expect(equityBreaches('92000.0000', '92000.0000')).toBe(true);
    expect(equityBreaches('92000.0001', '92000.0000')).toBe(false);
  });

  it('stresses a buy at the worst fill and ignores a favorable mark gap', () => {
    const buy = {
      quantity: '3000',
      quantityScale: 0,
      fillPrice: '11.00',
      mark: '10.00',
      priceScale: 2,
    };
    expect(stressedEquity('100000.0000', [buy])).toBe('96835.0000');
    expect(stressedEquity('100000.0000', [buy, buy])).toBe('93670.0000');
    expect(higherPrice('15.00', '12.00', 2)).toBe('15.00');
    expect(higherPrice('11.00', '12.00', 2)).toBe('12.00');
  });
});
