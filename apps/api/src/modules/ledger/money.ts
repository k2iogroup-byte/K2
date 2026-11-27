import { addDecimals, canonicalDecimal, decimalGreaterThan, subtractDecimals } from '@k2/shared';

const MONEY = 4;
const ZERO = '0.0000';

export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

/** Optional absolute bands. Production passes none, so every mismatch is CRITICAL. */
export type SeverityBands = {
  warningAbs: string;
  criticalAbs: string;
};

export function canonicalMoney(value: string): string {
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const absolute = canonicalDecimal(negative ? trimmed.slice(1) : trimmed, MONEY);
  if (negative && absolute !== ZERO) return `-${absolute}`;
  return absolute;
}

export function negateMoney(value: string): string {
  const canonical = canonicalMoney(value);
  if (canonical === ZERO) return ZERO;
  return canonical.startsWith('-') ? canonical.slice(1) : `-${canonical}`;
}

export function absoluteMoneyDifference(left: string, right: string): string {
  const a = canonicalMoney(left);
  const b = canonicalMoney(right);
  if (a === b) return ZERO;
  if (moneyGreater(a, b)) return canonicalMoney(subtractSigned(a, b));
  return canonicalMoney(subtractSigned(b, a));
}

/**
 * No bands: any difference is CRITICAL.
 * Bands, when a caller supplies both, are absolute amounts at scale 4.
 */
export function mismatchSeverity(
  expected: string,
  actual: string,
  bands?: SeverityBands,
): Severity {
  const gap = absoluteMoneyDifference(expected, actual);
  if (gap === ZERO) return 'INFO';
  if (!bands) return 'CRITICAL';
  const warning = canonicalMoney(bands.warningAbs);
  const critical = canonicalMoney(bands.criticalAbs);
  if (moneyGreater(warning, critical)) return 'CRITICAL';
  if (moneyGreater(gap, critical) || gap === critical) return 'CRITICAL';
  if (moneyGreater(gap, warning) || gap === warning) return 'WARNING';
  return 'INFO';
}

function moneyGreater(left: string, right: string): boolean {
  const a = canonicalMoney(left);
  const b = canonicalMoney(right);
  const aNeg = a.startsWith('-');
  const bNeg = b.startsWith('-');
  if (aNeg !== bNeg) return !aNeg;
  if (!aNeg) return decimalGreaterThan(a, b, MONEY);
  return decimalGreaterThan(b.slice(1), a.slice(1), MONEY);
}

function subtractSigned(left: string, right: string): string {
  const a = canonicalMoney(left);
  const b = canonicalMoney(right);
  if (b.startsWith('-')) return addSigned(a, b.slice(1));
  if (a.startsWith('-')) {
    const sum = addAbs(a.slice(1), b);
    return sum === ZERO ? ZERO : `-${sum}`;
  }
  if (decimalGreaterThan(b, a, MONEY)) {
    const diff = subtractAbs(b, a);
    return diff === ZERO ? ZERO : `-${diff}`;
  }
  return subtractAbs(a, b);
}

function addSigned(left: string, right: string): string {
  const a = canonicalMoney(left);
  const b = canonicalMoney(right);
  const aNeg = a.startsWith('-');
  const bNeg = b.startsWith('-');
  const aAbs = aNeg ? a.slice(1) : a;
  const bAbs = bNeg ? b.slice(1) : b;
  if (aNeg === bNeg) {
    const sum = addAbs(aAbs, bAbs);
    return aNeg && sum !== ZERO ? `-${sum}` : sum;
  }
  if (decimalGreaterThan(aAbs, bAbs, MONEY)) {
    const diff = subtractAbs(aAbs, bAbs);
    return aNeg && diff !== ZERO ? `-${diff}` : diff;
  }
  const diff = subtractAbs(bAbs, aAbs);
  return bNeg && diff !== ZERO ? `-${diff}` : diff;
}

function addAbs(left: string, right: string): string {
  return addDecimals(canonicalDecimal(left, MONEY), canonicalDecimal(right, MONEY), MONEY);
}

function subtractAbs(left: string, right: string): string {
  return subtractDecimals(canonicalDecimal(left, MONEY), canonicalDecimal(right, MONEY), MONEY);
}
