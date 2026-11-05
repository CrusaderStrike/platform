import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultMigrationsDir = path.resolve(here, '../../migrations');

export function checksumSql(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export type MigrateOptions = {
  /** Override migrations directory (tests). Defaults to repo `migrations/`. */
  migrationsDir?: string;
};

/**
 * Apply pending `*.sql` migrations in lexicographic order.
 *
 * Applied files are **immutable**: each row in `schema_migrations` stores a SHA-256 of the
 * file contents. On later boots we re-hash the file and refuse to start if it drifted.
 * Never edit an already-applied migration — add a new numbered file instead.
 */
export async function migrate(
  databaseUrl: string,
  opts?: MigrateOptions,
): Promise<string[]> {
  const migrationsDir = opts?.migrationsDir ?? defaultMigrationsDir;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const applied: string[] = [];
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        checksum TEXT
      )
    `);
    // Older DBs created schema_migrations without checksum; add it in place (table is ours).
    await pool.query(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT`);

    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const id = file;
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      const checksum = checksumSql(sql);
      const existing = await pool.query<{ checksum: string | null }>(
        'SELECT checksum FROM schema_migrations WHERE id = $1',
        [id],
      );
      if (existing.rowCount) {
        const stored = existing.rows[0]!.checksum;
        if (stored == null) {
          // First run after checksum support: backfill from the on-disk file.
          await pool.query('UPDATE schema_migrations SET checksum = $1 WHERE id = $2', [
            checksum,
            id,
          ]);
        } else if (stored !== checksum) {
          throw new Error(
            `Migration ${id} was edited after it was applied (checksum mismatch). ` +
              `Applied migrations are immutable — add a new numbered migration instead.`,
          );
        }
        continue;
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [
          id,
          checksum,
        ]);
        await client.query('COMMIT');
        applied.push(id);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
  return applied;
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirect) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  migrate(url)
    .then((applied) => {
      console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
