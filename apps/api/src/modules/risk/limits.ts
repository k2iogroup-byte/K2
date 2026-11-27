import { canonicalDecimal, decimalGreaterThan, multiplyDecimals } from '@k2/shared';

const MONEY = 4;
const DAILY_FACTOR = '0.9500';
const DRAWDOWN_FACTOR = '0.9200';

/** 0.95 times the day's highest equity. */
export function dailyLossFloor(highestEquity: string): string {
  return multiplyDecimals(
    canonicalDecimal(highestEquity, MONEY),
    DAILY_FACTOR,
    MONEY,
    MONEY,
    MONEY,
  );
}

/** Static 0.92 times the initial balance. The floor never rises. */
export function drawdownFloor(initialBalance: string): string {
  return multiplyDecimals(
    canonicalDecimal(initialBalance, MONEY),
    DRAWDOWN_FACTOR,
    MONEY,
    MONEY,
    MONEY,
  );
}

/** Founder rule: touching the floor is a breach. */
export function equityBreaches(equity: string, floor: string): boolean {
  return !decimalGreaterThan(
    canonicalDecimal(equity, MONEY),
    canonicalDecimal(floor, MONEY),
    MONEY,
  );
}
