import { describe, expect, it } from 'vitest';

import { dailyLossFloor, drawdownFloor, equityBreaches } from '../../src/modules/risk/limits.js';

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
});
