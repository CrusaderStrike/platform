import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(databaseUrl: string): Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    // Tests fire parallel gear writes; keep prod small.
    max: process.env.NODE_ENV === 'test' ? 80 : 10,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (err) => {
    // Idle clients can error when the embedded test cluster stops.
    if (process.env.NODE_ENV !== 'test') console.error('pg pool error', err);
  });
  return pool;
}
