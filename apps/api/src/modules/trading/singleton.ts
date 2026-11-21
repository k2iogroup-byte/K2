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

  state(): TradingLockState {
    return this.current;
  }

  fillsAllowed(): boolean {
    return this.current === 'held';
  }

  async acquire(connectionString: string): Promise<TradingLockState> {
    if (this.client) return this.current;
    const client = new pg.Client({ connectionString });
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
