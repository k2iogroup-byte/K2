export class DecimalError extends Error {
  constructor() {
    super('Invalid decimal');
    this.name = 'DecimalError';
  }
}

const DECIMAL = /^(0|[1-9]\d{0,17})(?:\.(\d+))?$/;

/** Exact decimal text. Extra fractional digits are rejected unless they are zeros. */
export function canonicalDecimal(value: string, scale: number): string {
  if (!Number.isInteger(scale) || scale < 0 || scale > 8) throw new DecimalError();
  const match = DECIMAL.exec(value.trim());
  if (!match || match[1] === undefined) throw new DecimalError();
  const fraction = match[2] ?? '';
  if (fraction.length > scale && !/^0+$/.test(fraction.slice(scale))) throw new DecimalError();
  if (scale === 0) return match[1];
  return `${match[1]}.${fraction.slice(0, scale).padEnd(scale, '0')}`;
}

export function decimalsEqual(left: string, right: string, scale: number): boolean {
  return canonicalDecimal(left, scale) === canonicalDecimal(right, scale);
}

export function decimalLessThan(left: string, right: string, scale: number): boolean {
  return compareScaled(left, right, scale) < 0;
}

export function decimalGreaterThan(left: string, right: string, scale: number): boolean {
  return compareScaled(left, right, scale) > 0;
}

export function addDecimals(left: string, right: string, scale: number): string {
  return formatScaled(scaledInteger(left, scale) + scaledInteger(right, scale), scale);
}

export function subtractDecimals(left: string, right: string, scale: number): string {
  const diff = scaledInteger(left, scale) - scaledInteger(right, scale);
  if (diff < 0n) return `-${formatScaled(-diff, scale)}`;
  return formatScaled(diff, scale);
}

export function multiplyDecimals(
  left: string,
  right: string,
  leftScale: number,
  rightScale: number,
  resultScale: number,
): string {
  const product = scaledInteger(left, leftScale) * scaledInteger(right, rightScale);
  return roundHalfAway(product, leftScale + rightScale, resultScale);
}

export function divideByInt(
  value: string,
  scale: number,
  divisor: bigint,
  resultScale: number,
): string {
  if (divisor <= 0n) throw new DecimalError();
  const numerator = scaledInteger(value, scale) * 10n ** BigInt(resultScale);
  const denominator = divisor * 10n ** BigInt(scale);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return formatScaled(rounded, resultScale);
}

function compareScaled(left: string, right: string, scale: number): number {
  const a = scaledInteger(left, scale);
  const b = scaledInteger(right, scale);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function scaledInteger(value: string, scale: number): bigint {
  const canonical = canonicalDecimal(value, scale);
  const [whole, fraction = ''] = canonical.split('.');
  return BigInt(`${whole}${fraction}`);
}

function roundHalfAway(value: bigint, fromScale: number, resultScale: number): string {
  if (!Number.isInteger(fromScale) || !Number.isInteger(resultScale)) throw new DecimalError();
  if (fromScale < resultScale) {
    return formatScaled(value * 10n ** BigInt(resultScale - fromScale), resultScale);
  }
  const factor = 10n ** BigInt(fromScale - resultScale);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const quotient = absolute / factor;
  const remainder = absolute % factor;
  const rounded = remainder * 2n >= factor ? quotient + 1n : quotient;
  return formatScaled(negative ? -rounded : rounded, resultScale);
}

function formatScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const body = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative ? `-${body}` : body;
}
