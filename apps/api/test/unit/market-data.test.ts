import { describe, expect, it } from 'vitest';

import {
  bucketStart,
  liveMarketDataClaim,
  MarketDataEngine,
  type RawQuote,
} from '../../src/modules/market-data/engine.js';
import { createProvider, TestFixtureProvider } from '../../src/modules/market-data/provider.js';

const equity = {
  id: '00000000-0000-4000-8000-000000000001',
  market: 'EQUITIES' as const,
  venue: 'NASDAQ' as const,
  symbol: 'TEST',
  providerSymbol: 'test',
  priceScale: 2,
  quantityScale: 0,
};

function quote(sequence: number, overrides: Partial<RawQuote> = {}): RawQuote {
  return {
    kind: 'quote',
    providerEventId: `q-${sequence}`,
    providerSymbol: 'test',
    bid: '10.00',
    ask: '10.10',
    bidSize: '100',
    askSize: '80',
    last: '10.05',
    sourceTimestamp: new Date(1_700_000_000_000 + sequence * 1000).toISOString(),
    sequence,
    ...overrides,
  };
}

describe('market data engine', () => {
  it('normalises symbols and keeps the three timestamps distinct', async () => {
    let now = new Date('2026-11-13T15:00:00.000Z');
    const engine = new MarketDataEngine(
      { providerId: 'test-fixture', priceOrigin: 'TEST_FIXTURE', clock: () => now },
      [equity],
    );
    const received = new Date('2026-11-13T15:00:01.000Z');
    now = new Date('2026-11-13T15:00:01.250Z');
    const result = await engine.ingest(
      quote(1, { providerSymbol: 'TEST', sourceTimestamp: '2026-11-13T15:00:00.500Z' }),
      received,
    );
    expect(result).toEqual({ status: 'accepted', kind: 'quote' });
    const stored = engine.quote('TEST', received);
    expect(stored?.symbol).toBe('TEST');
    expect(stored?.sourceTimestamp).toBe('2026-11-13T15:00:00.500Z');
    expect(stored?.receivedTimestamp).toBe(received.toISOString());
    expect(stored?.processedTimestamp).toBe('2026-11-13T15:00:01.250Z');
    expect(stored?.priceOrigin).toBe('TEST_FIXTURE');
    expect(engine.health(received).liveMarketData).toBe(false);
  });

  it('rejects invalid, out-of-order, and duplicate events', async () => {
    const engine = new MarketDataEngine(
      { providerId: 'test-fixture', priceOrigin: 'TEST_FIXTURE' },
      [equity],
    );
    const received = new Date('2026-11-13T15:00:00.000Z');
    expect((await engine.ingest(quote(1), received)).status).toBe('accepted');
    expect((await engine.ingest(quote(2, { bid: '11.00', ask: '10.00' }), received)).status).toBe(
      'rejected',
    );
    const older = await engine.ingest(quote(1, { providerEventId: 'older' }), received);
    expect(older.status === 'rejected' && older.reason).toBe('out_of_order');
    expect((await engine.ingest(quote(1), received)).status).toBe('duplicate');
    expect(engine.quote('TEST')?.sequence).toBe(1);
    const missing = await engine.ingest(quote(3, { providerSymbol: 'missing' }), received);
    expect(missing.status === 'rejected' && missing.reason).toBe('unknown_symbol');
  });

  it('fans out to consumers, detects gaps, and builds bars without calling a vendor', async () => {
    const engine = new MarketDataEngine(
      { providerId: 'test-fixture', priceOrigin: 'TEST_FIXTURE' },
      [equity],
    );
    const first: string[] = [];
    const second: string[] = [];
    engine.subscribe((event) => {
      if (event.type === 'quote') first.push(`q${event.quote.sequence}`);
      if (event.type === 'gap') first.push('gap');
    });
    engine.subscribe((event) => {
      if (event.type === 'trade') second.push(event.trade.price);
    });
    const received = new Date('2026-11-13T15:00:00.000Z');
    await engine.ingest(quote(1, { sourceTimestamp: received.toISOString() }), received);
    await engine.ingest(
      quote(4, { sourceTimestamp: '2026-11-13T15:00:04.000Z' }),
      new Date('2026-11-13T15:00:04.000Z'),
    );
    await engine.ingest(
      {
        kind: 'trade',
        providerEventId: 't-1',
        providerSymbol: 'test',
        price: '10.20',
        quantity: '5',
        sourceTimestamp: '2026-11-13T15:00:30.000Z',
        sequence: 5,
      },
      new Date('2026-11-13T15:00:30.000Z'),
    );
    await engine.ingest(
      {
        kind: 'trade',
        providerEventId: 't-2',
        providerSymbol: 'test',
        price: '10.00',
        quantity: '2',
        sourceTimestamp: '2026-11-13T15:01:10.000Z',
        sequence: 6,
      },
      new Date('2026-11-13T15:01:10.000Z'),
    );
    expect(first).toEqual(['q1', 'q4', 'gap']);
    expect(second).toEqual(['10.20', '10.00']);
    const minute = engine.barsFor('TEST', '1m');
    expect(minute).toHaveLength(2);
    expect(minute[0]).toMatchObject({
      open: '10.20',
      high: '10.20',
      low: '10.20',
      close: '10.20',
      volume: '5.00000000',
    });
    expect(minute[1]?.bucketStart).not.toBe(minute[0]?.bucketStart);
    expect(bucketStart(new Date('2026-11-13T15:07:40.000Z'), '5m').toISOString()).toBe(
      '2026-11-13T15:05:00.000Z',
    );
  });

  it('reports stale, disconnected, and reconnected feeds without a live-data claim', async () => {
    let now = new Date('2026-11-13T15:00:00.000Z');
    const engine = new MarketDataEngine(
      {
        providerId: 'test-fixture',
        priceOrigin: 'TEST_FIXTURE',
        clock: () => now,
        staleAfterMs: { EQUITIES: 1_000, CRYPTO: 1_000 },
      },
      [equity],
    );
    expect(engine.health(now)).toMatchObject({ feedState: 'DISCONNECTED', liveMarketData: false });
    await engine.ingest(quote(1), now);
    expect(engine.health(now).feedState).toBe('LIVE');
    expect(engine.health(now).liveMarketData).toBe(false);
    now = new Date(now.getTime() + 5_000);
    expect(engine.health(now).feedState).toBe('STALE');
    expect(engine.quote('TEST', now)?.feedState).toBe('STALE');
    await engine.ingest({ kind: 'disconnect' });
    expect(engine.health(now).feedState).toBe('DISCONNECTED');
    await engine.ingest({ kind: 'reconnect' });
    expect(engine.health(now).feedState).not.toBe('LIVE');
    now = new Date('2026-11-13T15:10:00.000Z');
    await engine.ingest(quote(2, { sourceTimestamp: now.toISOString() }), now);
    expect(engine.health(now)).toMatchObject({
      feedState: 'LIVE',
      priceOrigin: 'TEST_FIXTURE',
      liveMarketData: false,
      redistributionLicensed: false,
    });
    expect(liveMarketDataClaim('TEST_FIXTURE', 'LIVE')).toBe(false);
    expect(liveMarketDataClaim('VENDOR', 'STALE')).toBe(false);
    expect(liveMarketDataClaim('VENDOR', 'LIVE')).toBe(true);
  });

  it('keeps order across a high message volume for several consumers', async () => {
    const engine = new MarketDataEngine(
      { providerId: 'test-fixture', priceOrigin: 'TEST_FIXTURE' },
      [equity],
    );
    const counts = [0, 0, 0, 0];
    const last = [0, 0, 0, 0];
    for (let index = 0; index < counts.length; index += 1) {
      const cursor = index;
      engine.subscribe((event) => {
        if (event.type !== 'quote') return;
        counts[cursor] = (counts[cursor] ?? 0) + 1;
        expect(event.quote.sequence).toBe((last[cursor] ?? 0) + 1);
        last[cursor] = event.quote.sequence;
        expect(event.liveMarketData).toBe(false);
      });
    }
    const before = process.memoryUsage().heapUsed;
    const start = new Date('2026-11-13T15:00:00.000Z');
    for (let sequence = 1; sequence <= 5_000; sequence += 1) {
      const at = new Date(start.getTime() + sequence);
      await engine.ingest(
        quote(sequence, { sourceTimestamp: at.toISOString(), bid: '10.00', ask: '10.01' }),
        at,
      );
    }
    expect(counts).toEqual([5_000, 5_000, 5_000, 5_000]);
    expect(last).toEqual([5_000, 5_000, 5_000, 5_000]);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(80 * 1024 * 1024);
  });

  it('aggregates every supported timeframe, including gaps and invalid trades', async () => {
    const engine = new MarketDataEngine(
      { providerId: 'test-fixture', priceOrigin: 'TEST_FIXTURE' },
      [equity],
    );
    const buckets: Record<string, string> = {
      '1m': '2026-11-13T15:07:00.000Z',
      '5m': '2026-11-13T15:05:00.000Z',
      '15m': '2026-11-13T15:00:00.000Z',
      '1h': '2026-11-13T15:00:00.000Z',
      '4h': '2026-11-13T12:00:00.000Z',
      '1d': '2026-11-13T00:00:00.000Z',
    };
    const samples = [
      { id: 'a', price: '10.00', quantity: '2', at: '2026-11-13T15:07:10.000Z', sequence: 1 },
      { id: 'b', price: '12.50', quantity: '3', at: '2026-11-13T15:07:40.000Z', sequence: 2 },
      { id: 'c', price: '11.00', quantity: '1', at: '2026-11-13T15:07:50.000Z', sequence: 4 },
      { id: 'd', price: '9.00', quantity: '4', at: '2026-11-14T00:00:05.000Z', sequence: 5 },
    ];
    for (const sample of samples) {
      const received = new Date(sample.at);
      expect(
        (
          await engine.ingest(
            {
              kind: 'trade',
              providerEventId: sample.id,
              providerSymbol: 'test',
              price: sample.price,
              quantity: sample.quantity,
              sourceTimestamp: sample.at,
              sequence: sample.sequence,
            },
            received,
          )
        ).status,
      ).toBe('accepted');
    }
    const duplicate = await engine.ingest(
      {
        kind: 'trade',
        providerEventId: 'b',
        providerSymbol: 'test',
        price: '1.00',
        quantity: '9',
        sourceTimestamp: '2026-11-13T15:07:41.000Z',
        sequence: 3,
      },
      new Date('2026-11-13T15:07:41.000Z'),
    );
    expect(duplicate.status).toBe('duplicate');
    const backwards = await engine.ingest(
      {
        kind: 'trade',
        providerEventId: 'old',
        providerSymbol: 'test',
        price: '8.00',
        quantity: '1',
        sourceTimestamp: '2026-11-13T15:07:01.000Z',
        sequence: 6,
      },
      new Date('2026-11-13T15:08:00.000Z'),
    );
    expect(backwards.status === 'rejected' && backwards.reason).toBe('out_of_order');
    const invalidPrice = await engine.ingest(
      {
        kind: 'trade',
        providerEventId: 'bad-price',
        providerSymbol: 'test',
        price: '0',
        quantity: '1',
        sourceTimestamp: '2026-11-14T00:01:00.000Z',
        sequence: 7,
      },
      new Date('2026-11-14T00:01:00.000Z'),
    );
    expect(invalidPrice.status === 'rejected' && invalidPrice.reason).toBe('invalid');
    const invalidVolume = await engine.ingest(
      {
        kind: 'trade',
        providerEventId: 'bad-volume',
        providerSymbol: 'test',
        price: '10.00',
        quantity: '-1',
        sourceTimestamp: '2026-11-14T00:02:00.000Z',
        sequence: 8,
      },
      new Date('2026-11-14T00:02:00.000Z'),
    );
    expect(invalidVolume.status === 'rejected' && invalidVolume.reason).toBe('invalid');

    for (const timeframe of ['1m', '5m', '15m', '1h', '4h', '1d'] as const) {
      expect(bucketStart(new Date('2026-11-13T15:07:40.000Z'), timeframe).toISOString()).toBe(
        buckets[timeframe],
      );
    }
    const minute = engine.barsFor('TEST', '1m');
    expect(minute.map((bar) => bar.bucketStart)).toEqual([
      '2026-11-13T15:07:00.000Z',
      '2026-11-14T00:00:00.000Z',
    ]);
    expect(minute[0]).toMatchObject({
      open: '10.00',
      high: '12.50',
      low: '10.00',
      close: '11.00',
      volume: '6.00000000',
      tradeCount: 3,
      priceOrigin: 'TEST_FIXTURE',
    });
    expect(engine.barsFor('TEST', '15m')).toHaveLength(2);
    expect(engine.barsFor('TEST', '1h')[0]).toMatchObject({
      open: '10.00',
      high: '12.50',
      low: '10.00',
      close: '11.00',
      tradeCount: 3,
    });
    expect(engine.barsFor('TEST', '4h')[0]?.bucketStart).toBe('2026-11-13T12:00:00.000Z');
    expect(engine.barsFor('TEST', '1d')).toHaveLength(2);
    expect(engine.barsFor('TEST', '1d')[0]?.bucketStart).toBe('2026-11-13T00:00:00.000Z');
    expect(engine.barsFor('TEST', '1d')[1]?.bucketStart).toBe('2026-11-14T00:00:00.000Z');
    expect(engine.barsFor('TEST', '5m')[0]?.volume).toBe('6.00000000');
  });

  it('measures in-process fan-out without treating it as trader capacity', async () => {
    const engine = new MarketDataEngine(
      { providerId: 'test-fixture', priceOrigin: 'TEST_FIXTURE' },
      [equity],
    );
    const subscribers = 32;
    const events = 1_000;
    const counts = Array.from({ length: subscribers }, () => 0);
    for (let index = 0; index < subscribers; index += 1) {
      const cursor = index;
      engine.subscribe((event) => {
        if (event.type !== 'quote') return;
        counts[cursor] = (counts[cursor] ?? 0) + 1;
        expect(event.liveMarketData).toBe(false);
      });
    }
    const started = performance.now();
    const before = process.memoryUsage().heapUsed;
    let errors = 0;
    const start = new Date('2026-11-13T15:00:00.000Z');
    for (let sequence = 1; sequence <= events; sequence += 1) {
      const at = new Date(start.getTime() + sequence);
      const result = await engine.ingest(
        quote(sequence, { sourceTimestamp: at.toISOString(), bid: '10.00', ask: '10.01' }),
        at,
      );
      if (result.status !== 'accepted') errors += 1;
    }
    const elapsedMs = performance.now() - started;
    expect(errors).toBe(0);
    expect(counts.every((count) => count === events)).toBe(true);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(80 * 1024 * 1024);
    expect(elapsedMs).toBeLessThan(20_000);
    expect({
      subscribers,
      events,
      errors,
      elapsedMs: Math.round(elapsedMs),
    }).toMatchObject({ subscribers: 32, events: 1_000, errors: 0 });
  });

  it('keeps delivering when one consumer throws', async () => {
    const engine = new MarketDataEngine(
      { providerId: 'test-fixture', priceOrigin: 'TEST_FIXTURE' },
      [equity],
    );
    engine.subscribe(() => {
      throw new Error('consumer failed');
    });
    const seen: string[] = [];
    engine.subscribe((event) => {
      if (event.type === 'quote') seen.push(event.quote.symbol);
    });
    const received = new Date('2026-11-13T15:00:00.000Z');
    expect((await engine.ingest(quote(1), received)).status).toBe('accepted');
    expect(seen).toEqual(['TEST']);
  });

  it('keeps the fixture provider off the network', () => {
    expect(createProvider('disconnected')).toBeNull();
    const provider = createProvider('test-fixture');
    expect(provider).toBeInstanceOf(TestFixtureProvider);
    expect(provider?.priceOrigin).toBe('TEST_FIXTURE');
    const seen: string[] = [];
    provider?.start((event) => {
      if (event.kind === 'quote') seen.push(event.providerEventId);
    });
    if (provider instanceof TestFixtureProvider) provider.emit(quote(1));
    provider?.stop();
    if (provider instanceof TestFixtureProvider) provider.emit(quote(2));
    expect(seen).toEqual(['q-1']);
  });
});
