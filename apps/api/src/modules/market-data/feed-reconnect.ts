/**
 * Reconnect timing for the public Binance feed.
 * No socket is opened here. Delays are pure so tests do not touch the network.
 */

const BASE_MS = 1_000;
const CAP_MS = 60_000;

/** Full jitter in `[0, min(cap, 1000 * 2^(attempt-1))]`. Attempt 1 is about one second. */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const safeAttempt = Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
  const ceiling = Math.min(CAP_MS, BASE_MS * 2 ** (safeAttempt - 1));
  const unit = random();
  const jitter = Number.isFinite(unit) ? Math.min(1, Math.max(0, unit)) : 0;
  return Math.floor(ceiling * jitter);
}

/** `Retry-After` is a number of seconds. A ban waits at least that long. */
export function retryAfterDelayMs(retryAfterSeconds: number): number {
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) return 0;
  return Math.floor(retryAfterSeconds * 1000);
}

export type FeedLink = 'up' | 'down';

export class FeedLinkState {
  private link: FeedLink = 'down';

  constructor(private readonly onChange: (link: FeedLink) => void) {}

  up(): void {
    if (this.link === 'up') return;
    this.link = 'up';
    this.onChange('up');
  }

  down(): void {
    if (this.link === 'down') return;
    this.link = 'down';
    this.onChange('down');
  }

  get current(): FeedLink {
    return this.link;
  }
}
