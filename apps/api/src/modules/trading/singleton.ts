import pg from 'pg';

/** Dedicated session lock. Not the transaction lock used to insert a position. */
export const TRADING_SINGLETON_KEY = 4_053_205;

export type TradingLockState = 'held' | 'unavailable' | 'lost';

/**
 * One API process holds this lock on a connection that is not from the pool.
 * A dropped connection is not re-acquired.
 */
export class TradingLock {
  private client: pg.Client | null = null;
  private current: TradingLockState = 'unavailable';
  private acquiring = false;

  state(): TradingLockState {
    return this.current;
  }

  fillsAllowed(): boolean {
    return this.current === 'held';
  }

  /**
   * While this process is waiting, try the lock again. A lost lock is not retried.
   * Only one connection can hold it, so a standby replica still cannot trade.
   */
  retryWhileWaiting(connectionString: string, intervalMs = 2_000): () => void {
    const timer = setInterval(() => {
      if (this.current !== 'unavailable') return;
      void this.acquire(connectionString).catch(() => undefined);
    }, intervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  }

  async acquire(connectionString: string): Promise<TradingLockState> {
    if (this.current === 'lost' || this.client || this.acquiring) return this.current;
    this.acquiring = true;
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      const locked = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [TRADING_SINGLETON_KEY],
      );
      if (locked.rows[0]?.locked !== true) {
        await client.end();
        this.current = 'unavailable';
        return this.current;
      }
      const lose = (): void => {
        if (this.current === 'held') this.current = 'lost';
      };
      client.on('error', lose);
      client.on('end', lose);
      this.client = client;
      this.current = 'held';
      return this.current;
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    } finally {
      this.acquiring = false;
    }
  }

  /** The connection dropped or was closed. Fills stay stopped. */
  async drop(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (this.current === 'held') this.current = 'lost';
    if (!client) return;
    client.removeAllListeners('error');
    client.removeAllListeners('end');
    await client.end().catch(() => undefined);
  }

  async release(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.current = 'unavailable';
    if (!client) return;
    client.removeAllListeners('error');
    client.removeAllListeners('end');
    await client.end().catch(() => undefined);
  }
}

export async function tryHoldSingleton(connectionString: string): Promise<pg.Client | null> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const locked = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS locked',
    [TRADING_SINGLETON_KEY],
  );
  if (locked.rows[0]?.locked !== true) {
    await client.end();
    return null;
  }
  return client;
}
