import { describe, expect, it } from 'vitest';

import { startCatalogSync } from '../../src/modules/market-data/catalog-sync.js';
import {
  filterViolation,
  instrumentScale,
} from '../../src/modules/market-data/exchange-filters.js';

const filters = {
  tickSize: '0.00000123',
  stepSize: '1',
  minQty: '1',
  maxQty: '9000000000',
  minNotional: '1',
};

describe('exchange filters', () => {
  it('keeps the tiny price and the billion quantity on the step and tick', () => {
    expect(instrumentScale('0.00000123')).toBe(8);
    expect(instrumentScale('0.01000000')).toBe(2);
    expect(instrumentScale('100000')).toBe(0);
    expect(filterViolation(filters, '0.00000123', '1000000000', true)).toBeNull();
    expect(filterViolation(filters, '0.00000124', '1000000000', true)).toBe('TICK_SIZE');
    expect(filterViolation(filters, '0.00000123', '1.5', true)).toBe('STEP_SIZE');
    expect(filterViolation(filters, '0.00000123', '0', true)).toBe('TICK_SIZE');
    expect(
      filterViolation({ ...filters, minQty: '2', minNotional: '0' }, '0.00000123', '1', true),
    ).toBe('MIN_QTY');
    expect(
      filterViolation(
        {
          tickSize: '0.01',
          stepSize: '0.00001',
          minQty: '0.00001',
          maxQty: '9000',
          minNotional: '5',
        },
        '100000',
        '0.00001',
        true,
      ),
    ).toBe('MIN_NOTIONAL');
    expect(
      filterViolation(
        {
          tickSize: '0.01',
          stepSize: '0.00001',
          minQty: '0.00001',
          maxQty: '9000',
          minNotional: '5',
        },
        '100000',
        '0.00010',
        true,
      ),
    ).toBeNull();
  });

  it('runs the catalog only while the lock is held', async () => {
    let calls = 0;
    const idle = startCatalogSync({
      pool: {} as never,
      lock: { fillsAllowed: () => false },
      load: () => {
        calls += 1;
        return Promise.resolve(null);
      },
    });
    idle.stop();
    const held = startCatalogSync({
      pool: {} as never,
      lock: { fillsAllowed: () => true },
      load: () => {
        calls += 1;
        return Promise.resolve(null);
      },
      intervalMs: 60_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    held.stop();
    expect(calls).toBe(1);
  });
});
