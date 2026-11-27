import {
  addDecimals,
  canonicalDecimal,
  DecimalError,
  decimalGreaterThan,
  multiplyDecimals,
} from '@k2/shared';

import { quotePriceToUsd, settlesAsUsd } from './usdt-usd.js';

/** Cash and position value share the simulation money scale. */
export const EQUITY_SCALE = 4;

export type EquityLeg = {
  quantity: string;
  quantityScale: number;
  /** Quote-currency bid. USD is used as-is. USDT is mapped 1:1. */
  bid: string;
  priceScale: number;
  quoteAsset: string;
};

/**
 * One equity. Cash already includes the opening fee.
 * Open longs are marked at the bid. A missing or unusable mark returns null.
 */
export function accountEquity(cash: string, legs: readonly EquityLeg[]): string | null {
  try {
    let total = canonicalDecimal(cash, EQUITY_SCALE);
    for (const leg of legs) {
      const quantity = canonicalDecimal(leg.quantity, leg.quantityScale);
      if (!decimalGreaterThan(quantity, '0', leg.quantityScale)) continue;
      if (!settlesAsUsd(leg.quoteAsset)) return null;
      const bid = quotePriceToUsd(leg.quoteAsset, leg.bid, leg.priceScale);
      const value = multiplyDecimals(
        bid,
        quantity,
        leg.priceScale,
        leg.quantityScale,
        EQUITY_SCALE,
      );
      total = addDecimals(total, value, EQUITY_SCALE);
    }
    return total;
  } catch (error) {
    if (error instanceof DecimalError) return null;
    throw error;
  }
}
