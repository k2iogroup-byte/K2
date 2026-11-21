import { canonicalDecimal, DecimalError, multiplyDecimals } from '@k2/shared';

/**
 * Founder decision 2026-11-21: 1 USDT settles as 1 USD.
 * The rate is the decimal text "1". There is no float and no live conversion.
 */
export const USDT_USD_RATE = '1';

export function settlesAsUsd(quoteAsset: string | null): boolean {
  return quoteAsset === 'USD' || quoteAsset === 'USDT';
}

/** Map a quote price into USD. USD is unchanged. USDT is multiplied by the 1:1 rate. */
export function quotePriceToUsd(quoteAsset: string, price: string, scale: number): string {
  const canonical = canonicalDecimal(price, scale);
  if (quoteAsset === 'USD') return canonical;
  if (quoteAsset === 'USDT') return multiplyDecimals(canonical, USDT_USD_RATE, scale, 0, scale);
  throw new DecimalError();
}
