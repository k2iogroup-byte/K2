export type RateDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

export interface RateLimiter {
  consume(key: string, limit: number, windowMs: number): RateDecision | Promise<RateDecision>;
  failureCount(key: string, windowMs: number): number | Promise<number>;
  recordFailure(key: string, windowMs: number): number | Promise<number>;
  oldestFailureAgeMs(key: string, windowMs: number): number | null | Promise<number | null>;
  clearFailures(key: string): void | Promise<void>;
}

type Bucket = {
  count: number;
  resetAt: number;
};

export function progressiveDelayMs(priorFailures: number, baseMs: number, capMs: number): number {
  if (priorFailures <= 0 || baseMs <= 0 || capMs <= 0) return 0;
  const exponent = Math.min(priorFailures - 1, 6);
  return Math.min(capMs, baseMs * 2 ** exponent);
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  consume(key: string, limit: number, windowMs: number): RateDecision {
    this.pruneBuckets();
    const now = this.now();
    const existing = this.buckets.get(key);
    if (!existing || now >= existing.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { ok: true };
    }
    if (existing.count >= limit) {
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }
    existing.count += 1;
    return { ok: true };
  }

  failureCount(key: string, windowMs: number): number {
    return this.pruneFailures(key, windowMs).length;
  }

  recordFailure(key: string, windowMs: number): number {
    const kept = this.pruneFailures(key, windowMs);
    kept.push(this.now());
    this.failures.set(key, kept);
    return kept.length;
  }

  oldestFailureAgeMs(key: string, windowMs: number): number | null {
    const kept = this.pruneFailures(key, windowMs);
    const oldest = kept[0];
    if (oldest === undefined) return null;
    return this.now() - oldest;
  }

  clearFailures(key: string): void {
    this.failures.delete(key);
  }

  clear(): void {
    this.buckets.clear();
    this.failures.clear();
  }

  private pruneFailures(key: string, windowMs: number): number[] {
    const now = this.now();
    const kept = (this.failures.get(key) ?? []).filter((at) => now - at < windowMs);
    if (kept.length === 0) this.failures.delete(key);
    else this.failures.set(key, kept);
    return kept;
  }

  private pruneBuckets(): void {
    if (this.buckets.size < 5_000) return;
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key);
    }
  }
}
