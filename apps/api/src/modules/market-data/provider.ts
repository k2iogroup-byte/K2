import type { PriceOrigin } from '@k2/shared';

import type { RawProviderEvent } from './engine.js';

/** Provider adapters stay outside the rest of the platform. None opens a network connection. */
export interface MarketDataProvider {
  readonly id: string;
  readonly priceOrigin: PriceOrigin;
  start(onEvent: (event: RawProviderEvent) => void): void;
  stop(): void;
}

export class TestFixtureProvider implements MarketDataProvider {
  readonly priceOrigin = 'TEST_FIXTURE' as const;
  private handler: ((event: RawProviderEvent) => void) | null = null;

  constructor(readonly id: string) {}

  start(onEvent: (event: RawProviderEvent) => void): void {
    this.handler = onEvent;
  }

  stop(): void {
    this.handler = null;
  }

  emit(event: RawProviderEvent): void {
    this.handler?.(event);
  }
}

export function createProvider(mode: 'disconnected' | 'test-fixture'): MarketDataProvider | null {
  if (mode === 'disconnected') return null;
  return new TestFixtureProvider('test-fixture');
}
