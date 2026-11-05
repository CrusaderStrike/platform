import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(databaseUrl: string): Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (err) => {
    // Idle clients can error when the embedded test cluster stops.
    if (process.env.NODE_ENV !== 'test') console.error('pg pool error', err);
  });
  return pool;
}
