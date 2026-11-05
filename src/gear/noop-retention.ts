/**
 * Retention for gear_op_noop_ids (platform#47).
 *
 * Rows record op_ids of no-op set_slot/clear_slot so retries stay deduped without a
 * version bump. Without a TTL the table grows without bound.
 *
 * Default window: 30 days (override with GEAR_OP_NOOP_RETENTION_DAYS). Addon
 * pending_ops have no TTL; a retry older than the window is re-evaluated
 * (still a no-op → applied with no version bump, or stale_base_version if the
 * list moved). base_version remains the conflict guard.
 *
 * Deletes go through SECURITY DEFINER prune_gear_op_noop_ids so crusaderstrike_app
 * can sweep with no guild context under FORCE RLS.
 */
import type { Pool, PoolClient } from '../db/pool.js';

export type Db = Pool | PoolClient;

/** Default days to keep noop op_id markers (env may override via resolveRetentionDays). */
export const GEAR_OP_NOOP_RETENTION_DAYS_DEFAULT = 30;

/** @deprecated Prefer resolveRetentionDays() / opts.retentionDays; kept for tests. */
export const GEAR_OP_NOOP_RETENTION_DAYS = GEAR_OP_NOOP_RETENTION_DAYS_DEFAULT;

/** Cap per prune pass so a large backlog cannot hold a long lock. */
export const GEAR_OP_NOOP_PRUNE_BATCH = 5_000;

/** Default in-process sweep interval (cheap; table is tiny). */
export const GEAR_OP_NOOP_PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** At most one opportunistic write-path prune per process in this window. */
export const GEAR_OP_NOOP_WRITE_PRUNE_THROTTLE_MS = 60 * 1000; // 1 minute

/**
 * Stable advisory-lock key for the hourly sweeper (one holder across instances).
 * hashtext('crusaderstrike:gear_op_noop_ids_prune') as a fixed int4 pair via two keys.
 */
export const GEAR_OP_NOOP_PRUNE_LOCK_KEY1 = 0x4353_476e; // 'CSGn'
export const GEAR_OP_NOOP_PRUNE_LOCK_KEY2 = 0x6f6f_7052; // 'oopR'

export type PruneNoopResult = { deleted: number };

export type PruneNoopOpts = {
  retentionDays?: number;
  /** Override "now" for tests (timestamptz). */
  now?: Date;
  limit?: number;
};

/** Validate / coerce retention days (1..3650). */
export function resolveRetentionDays(
  raw: string | number | undefined | null,
  fallback: number = GEAR_OP_NOOP_RETENTION_DAYS_DEFAULT,
): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > 3650) {
    throw new Error(
      'GEAR_OP_NOOP_RETENTION_DAYS must be an integer between 1 and 3650',
    );
  }
  return n;
}

type PruneFn = (db: Db, opts?: PruneNoopOpts) => Promise<PruneNoopResult>;

async function defaultPrune(db: Db, opts?: PruneNoopOpts): Promise<PruneNoopResult> {
  const days = opts?.retentionDays ?? resolveRetentionDays(process.env.GEAR_OP_NOOP_RETENTION_DAYS);
  const limit = opts?.limit ?? GEAR_OP_NOOP_PRUNE_BATCH;
  const now = opts?.now ?? new Date();

  const r = await db.query<{ prune_gear_op_noop_ids: number }>(
    `SELECT prune_gear_op_noop_ids($1::int, $2::int, $3::timestamptz) AS prune_gear_op_noop_ids`,
    [days, limit, now.toISOString()],
  );
  return { deleted: Number(r.rows[0]?.prune_gear_op_noop_ids ?? 0) };
}

/** Overridable for tests (forced-failure). */
let pruneFn: PruneFn = defaultPrune;

/** Test-only: replace prune implementation. Pass null to restore default. */
export function setPruneExpiredNoopOpIdsForTests(fn: PruneFn | null): void {
  pruneFn = fn ?? defaultPrune;
}

/**
 * Delete expired gear_op_noop_ids via SECURITY DEFINER (works as app role, no guild).
 * Batched with FOR UPDATE SKIP LOCKED inside the SQL function.
 */
export async function pruneExpiredNoopOpIds(
  db: Db,
  opts?: PruneNoopOpts,
): Promise<PruneNoopResult> {
  return pruneFn(db, opts);
}

let lastWritePathPruneAt = 0;

/** Test-only: reset write-path throttle clock. */
export function resetWritePathPruneThrottleForTests(): void {
  lastWritePathPruneAt = 0;
}

/**
 * After COMMIT of /ops or /sync: fire-and-forget opportunistic prune on the pool.
 * Never runs inside the user transaction. Throttled per process.
 * Failures are logged and never surface to the client (write already committed).
 */
export function scheduleWritePathNoopPrune(
  pool: Pool,
  opts?: {
    retentionDays?: number;
    throttleMs?: number;
    limit?: number;
    log?: (msg: string, err?: unknown) => void;
  },
): void {
  const throttleMs = opts?.throttleMs ?? GEAR_OP_NOOP_WRITE_PRUNE_THROTTLE_MS;
  const now = Date.now();
  if (now - lastWritePathPruneAt < throttleMs) return;
  lastWritePathPruneAt = now;
  const log =
    opts?.log ??
    ((msg, err) => {
      if (err !== undefined) console.error(msg, err);
      else console.debug(msg);
    });
  void pruneExpiredNoopOpIds(pool, {
    retentionDays: opts?.retentionDays,
    limit: opts?.limit ?? 200,
  })
    .then((r) => {
      if (r.deleted > 0) {
        log(`gear_op_noop_ids write-path prune deleted=${r.deleted}`);
      } else {
        log('gear_op_noop_ids write-path prune deleted=0');
      }
    })
    .catch((err) => {
      log('gear_op_noop_ids write-path prune failed', err);
    });
}

export type NoopRetentionJob = {
  stop: () => void;
};

/**
 * Cheap periodic in-process prune. No external cron/queue.
 * Uses pg_try_advisory_lock so only one instance sweeps at a time.
 * Errors are logged and swallowed so a prune failure never takes down the API.
 */
export function startNoopRetentionJob(
  pool: Pool,
  opts?: {
    intervalMs?: number;
    retentionDays?: number;
    log?: (msg: string, err?: unknown) => void;
  },
): NoopRetentionJob {
  const intervalMs = opts?.intervalMs ?? GEAR_OP_NOOP_PRUNE_INTERVAL_MS;
  const retentionDays =
    opts?.retentionDays ?? resolveRetentionDays(process.env.GEAR_OP_NOOP_RETENTION_DAYS);
  const log =
    opts?.log ??
    ((msg, err) => {
      if (err !== undefined) console.error(msg, err);
      else console.log(msg);
    });
  const debug =
    opts?.log ??
    ((msg: string) => {
      console.debug(msg);
    });

  const tick = async () => {
    const client = await pool.connect();
    let locked = false;
    try {
      const got = await client.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock($1, $2) AS ok`,
        [GEAR_OP_NOOP_PRUNE_LOCK_KEY1, GEAR_OP_NOOP_PRUNE_LOCK_KEY2],
      );
      locked = Boolean(got.rows[0]?.ok);
      if (!locked) {
        debug('gear_op_noop_ids prune skipped (advisory lock held)');
        return;
      }
      let total = 0;
      for (let i = 0; i < 20; i++) {
        const { deleted } = await pruneExpiredNoopOpIds(client, { retentionDays });
        total += deleted;
        if (deleted < GEAR_OP_NOOP_PRUNE_BATCH) break;
      }
      if (total > 0) {
        log(`gear_op_noop_ids prune deleted=${total} retention_days=${retentionDays}`);
      } else {
        debug(`gear_op_noop_ids prune deleted=0 retention_days=${retentionDays}`);
      }
    } catch (err) {
      log('gear_op_noop_ids prune failed', err);
    } finally {
      if (locked) {
        try {
          await client.query(`SELECT pg_advisory_unlock($1, $2)`, [
            GEAR_OP_NOOP_PRUNE_LOCK_KEY1,
            GEAR_OP_NOOP_PRUNE_LOCK_KEY2,
          ]);
        } catch (err) {
          log('gear_op_noop_ids prune unlock failed', err);
        }
      }
      client.release();
    }
  };

  const initial = setTimeout(() => {
    void tick();
  }, 15_000);
  const handle = setInterval(() => {
    void tick();
  }, intervalMs);
  if (typeof initial.unref === 'function') initial.unref();
  if (typeof handle.unref === 'function') handle.unref();

  return {
    stop: () => {
      clearTimeout(initial);
      clearInterval(handle);
    },
  };
}
