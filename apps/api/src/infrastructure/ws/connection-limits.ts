/** Abuse caps for one API process. They are not shared across replicas. */
export const DEFAULT_MAX_SOCKETS = 500;
export const DEFAULT_MAX_SOCKETS_PER_IP = 20;

export class ConnectionLimiter {
  private total = 0;
  private readonly perIp = new Map<string, number>();

  constructor(
    private readonly maxTotal = DEFAULT_MAX_SOCKETS,
    private readonly maxPerIp = DEFAULT_MAX_SOCKETS_PER_IP,
  ) {
    if (
      !Number.isInteger(maxTotal) ||
      !Number.isInteger(maxPerIp) ||
      maxTotal < 1 ||
      maxPerIp < 1
    ) {
      throw new Error('Connection limits must be positive integers');
    }
  }

  tryAcquire(ip: string): boolean {
    const current = this.perIp.get(ip) ?? 0;
    if (this.total >= this.maxTotal || current >= this.maxPerIp) return false;
    this.perIp.set(ip, current + 1);
    this.total += 1;
    return true;
  }

  release(ip: string): void {
    const current = this.perIp.get(ip) ?? 0;
    if (current <= 1) this.perIp.delete(ip);
    else this.perIp.set(ip, current - 1);
    if (this.total > 0) this.total -= 1;
  }
}

/** Counts messages inside a sliding window without retaining the messages. */
export class MessageWindow {
  private count = 0;
  private startedAt = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  allow(): boolean {
    const now = this.now();
    if (this.startedAt === 0 || now - this.startedAt >= this.windowMs) {
      this.startedAt = now;
      this.count = 1;
      return true;
    }
    this.count += 1;
    return this.count <= this.limit;
  }
}
