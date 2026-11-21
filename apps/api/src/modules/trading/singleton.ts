import pg from 'pg';

/** Dedicated session lock. Not the transaction lock used to insert a position. */
export const TRADING_SINGLETON_KEY = 4_053_205;

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
