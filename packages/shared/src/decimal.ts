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

function formatScaled(value: bigint, scale: number): string {
  const digits = value.toString().padStart(scale + 1, '0');
  if (scale === 0) return digits;
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}
