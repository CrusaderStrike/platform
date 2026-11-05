import { describe, it, expect, afterEach } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { migrate, checksumSql } from '../src/db/migrate.js';
import pg from 'pg';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('no port'));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

describe('migration checksum immutability', () => {
  let pgInst: EmbeddedPostgres | null = null;
  let dataDir: string | null = null;
  let migrationsDir: string | null = null;
  let databaseUrl = '';

  afterEach(async () => {
    if (pgInst) {
      try {
        await pgInst.stop();
      } catch {
        /* ignore */
      }
      pgInst = null;
    }
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      dataDir = null;
    }
    if (migrationsDir) {
      await rm(migrationsDir, { recursive: true, force: true });
      migrationsDir = null;
    }
  });

  async function boot(): Promise<void> {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'cs-mig-pg-'));
    migrationsDir = await mkdtemp(path.join(os.tmpdir(), 'cs-mig-sql-'));
    const port = await freePort();
    pgInst = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: 'postgres',
      password: 'postgres',
      port,
      persistent: false,
      autoRehydrateSymlinks: true,
    });
    await pgInst.initialise();
    await pgInst.start();
    await pgInst.createDatabase('crusaderstrike');
    databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/crusaderstrike`;
  }

  it('stores checksums and refuses an edited applied migration', async () => {
    await boot();
    const file = path.join(migrationsDir!, '001_demo.sql');
    const original = 'CREATE TABLE demo (id INT PRIMARY KEY);\n';
    await writeFile(file, original, 'utf8');

    const first = await migrate(databaseUrl, { migrationsDir: migrationsDir! });
    expect(first).toEqual(['001_demo.sql']);

    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      const row = await pool.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE id = $1',
        ['001_demo.sql'],
      );
      expect(row.rows[0]!.checksum).toBe(checksumSql(original));

      // Idempotent re-run with unchanged file
      const second = await migrate(databaseUrl, { migrationsDir: migrationsDir! });
      expect(second).toEqual([]);

      // Edit in place after apply → must fail
      await writeFile(file, original + '-- drifted\n', 'utf8');
      await expect(migrate(databaseUrl, { migrationsDir: migrationsDir! })).rejects.toThrow(
        /edited after it was applied|checksum mismatch|immutable/i,
      );
    } finally {
      await pool.end();
    }
  });

  it('backfills null checksums on first run after upgrade', async () => {
    await boot();
    const file = path.join(migrationsDir!, '001_demo.sql');
    const sql = 'CREATE TABLE demo (id INT PRIMARY KEY);\n';
    await writeFile(file, sql, 'utf8');

    // Simulate a pre-checksum schema_migrations row
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      await pool.query(`
        CREATE TABLE schema_migrations (
          id TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await pool.query(`CREATE TABLE demo (id INT PRIMARY KEY)`);
      await pool.query(`INSERT INTO schema_migrations (id) VALUES ('001_demo.sql')`);

      const applied = await migrate(databaseUrl, { migrationsDir: migrationsDir! });
      expect(applied).toEqual([]);

      const row = await pool.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE id = $1',
        ['001_demo.sql'],
      );
      expect(row.rows[0]!.checksum).toBe(checksumSql(sql));
    } finally {
      await pool.end();
    }
  });
});
