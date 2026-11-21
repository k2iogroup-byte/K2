export const MAX_TRADING_SOCKETS_PER_USER = 4;

export type TradingSocketEvent = {
  type: 'order' | 'fill' | 'position' | 'protection';
  sequence: string;
  accountId: string;
  liveMarketData: false;
  executionVenue: 'K2_SIMULATION';
};

type FanoutSocket = {
  send(data: string): void;
};

/** In-process delivery. A socket only receives events for its signed-in user. */
export class TradingFanout {
  private readonly sockets = new Map<string, Set<FanoutSocket>>();
  private readonly sequences = new Map<string, bigint>();

  constructor(private readonly maxPerUser = MAX_TRADING_SOCKETS_PER_USER) {}

  join(userId: string, socket: FanoutSocket): boolean {
    const current = this.sockets.get(userId) ?? new Set<FanoutSocket>();
    if (current.size >= this.maxPerUser) return false;
    current.add(socket);
    this.sockets.set(userId, current);
    return true;
  }

  leave(userId: string, socket: FanoutSocket): void {
    const current = this.sockets.get(userId);
    if (!current) return;
    current.delete(socket);
    if (current.size === 0) this.sockets.delete(userId);
  }

  publish(
    userId: string,
    event: Omit<TradingSocketEvent, 'sequence' | 'liveMarketData' | 'executionVenue'>,
  ): void {
    const sequence = (this.sequences.get(userId) ?? 0n) + 1n;
    this.sequences.set(userId, sequence);
    const body = JSON.stringify({
      ...event,
      sequence: sequence.toString(),
      liveMarketData: false,
      executionVenue: 'K2_SIMULATION',
    });
    for (const socket of this.sockets.get(userId) ?? []) socket.send(body);
  }
}
