import {
  addDecimals,
  canonicalDecimal,
  decimalGreaterThan,
  divideByInt,
  multiplyDecimals,
  subtractDecimals,
} from '@k2/shared';

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

export type StressedBuy = {
  quantity: string;
  quantityScale: number;
  fillPrice: string;
  mark: string;
  priceScale: number;
};

/** Equity after pending buys are assumed filled. Sells are not included. */
export function stressedEquity(equity: string, buys: readonly StressedBuy[]): string {
  let total = canonicalDecimal(equity, MONEY);
  for (const buy of buys) {
    const notional = multiplyDecimals(
      buy.fillPrice,
      buy.quantity,
      buy.priceScale,
      buy.quantityScale,
      MONEY,
    );
    const fee = divideByInt(
      multiplyDecimals(notional, '0.5000', MONEY, MONEY, MONEY),
      MONEY,
      100n,
      MONEY,
    );
    const marked = multiplyDecimals(
      buy.mark,
      buy.quantity,
      buy.priceScale,
      buy.quantityScale,
      MONEY,
    );
    total = signedAdd(total, subtractDecimals(marked, notional, MONEY));
    total = signedAdd(total, `-${fee}`);
  }
  return total;
}

/** Touching either floor rejects. A negative stressed equity is below every floor. */
export function stressedBreaches(equity: string, floor: string): boolean {
  if (equity.startsWith('-')) return true;
  return equityBreaches(equity, floor);
}

export function higherPrice(left: string, right: string, scale: number): string {
  const a = canonicalDecimal(left, scale);
  const b = canonicalDecimal(right, scale);
  return decimalGreaterThan(a, b, scale) ? a : b;
}

const ZERO = '0.0000';

function signedAdd(left: string, right: string): string {
  const leftNeg = left.startsWith('-');
  const rightNeg = right.startsWith('-');
  const a = canonicalDecimal(leftNeg ? left.slice(1) : left, MONEY);
  const b = canonicalDecimal(rightNeg ? right.slice(1) : right, MONEY);
  if (b === ZERO) return leftNeg && a !== ZERO ? `-${a}` : a;
  if (a === ZERO) return rightNeg ? `-${b}` : b;
  if (leftNeg === rightNeg) {
    const sum = addDecimals(a, b, MONEY);
    return leftNeg ? `-${sum}` : sum;
  }
  if (decimalGreaterThan(a, b, MONEY)) {
    const diff = subtractDecimals(a, b, MONEY);
    return leftNeg && diff !== ZERO ? `-${diff}` : diff;
  }
  const diff = subtractDecimals(b, a, MONEY);
  if (diff === ZERO) return diff;
  return rightNeg ? `-${diff}` : diff;
}
