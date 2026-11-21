const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

export type ExchangeFilters = {
  tickSize: string;
  stepSize: string;
  minQty: string;
  maxQty: string;
  minNotional: string;
};

/** Decimal places after stripping trailing zeros. Capped at 8 for instruments.price_scale. */
export function instrumentScale(value: string): number {
  const fraction = fractionDigits(value).replace(/0+$/, '');
  return Math.min(8, fraction.length);
}

export function filterViolation(
  filters: ExchangeFilters,
  price: string,
  quantity: string,
  checkNotional: boolean,
): 'TICK_SIZE' | 'STEP_SIZE' | 'MIN_QTY' | 'MAX_QTY' | 'MIN_NOTIONAL' | null {
  if (!isPositiveDecimal(price) || !isPositiveDecimal(quantity)) return 'TICK_SIZE';
  if (!divides(price, filters.tickSize)) return 'TICK_SIZE';
  if (!divides(quantity, filters.stepSize)) return 'STEP_SIZE';
  if (compare(quantity, filters.minQty) < 0) return 'MIN_QTY';
  if (compare(quantity, filters.maxQty) > 0) return 'MAX_QTY';
  if (checkNotional && compareProduct(price, quantity, filters.minNotional) < 0) {
    return 'MIN_NOTIONAL';
  }
  return null;
}

function isPositiveDecimal(value: string): boolean {
  return DECIMAL.test(value.trim()) && compare(value, '0') > 0;
}

function fractionDigits(value: string): string {
  return value.trim().split('.')[1] ?? '';
}

function divides(value: string, step: string): boolean {
  if (!DECIMAL.test(step.trim()) || compare(step, '0') <= 0) return false;
  const scale = Math.max(fractionDigits(value).length, fractionDigits(step).length);
  const units = scaled(value, scale);
  const stepUnits = scaled(step, scale);
  return stepUnits !== 0n && units % stepUnits === 0n;
}

function compare(left: string, right: string): number {
  const scale = Math.max(fractionDigits(left).length, fractionDigits(right).length);
  const a = scaled(left, scale);
  const b = scaled(right, scale);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareProduct(price: string, quantity: string, minimum: string): number {
  const priceScale = fractionDigits(price).length;
  const qtyScale = fractionDigits(quantity).length;
  const product = scaled(price, priceScale) * scaled(quantity, qtyScale);
  const productScale = priceScale + qtyScale;
  const minScale = fractionDigits(minimum).length;
  const left = product * 10n ** BigInt(minScale);
  const right = scaled(minimum, minScale) * 10n ** BigInt(productScale);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function scaled(value: string, scale: number): bigint {
  const [whole, fraction = ''] = value.trim().split('.');
  const digits = `${whole}${fraction.slice(0, scale).padEnd(scale, '0')}`;
  return BigInt(digits);
}
