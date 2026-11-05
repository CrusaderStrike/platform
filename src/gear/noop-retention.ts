/**
 * Retention for gear_op_noop_ids (platform#47).
 *
 * Rows record op_ids of no-op set_slot/clear_slot so retries stay deduped without a
 * version bump. Without a TTL the table grows without bound.
 *
 * Window: 30 days. No gear offline-replay TTL is documented in groom/sync docs;
 * addon loot capture keeps un-uploaded drops at least 30 days — use the same bound
 * so companion/addon retries within that horizon still hit duplicates[].
 */
import type { Pool, PoolClient } from '../db/pool.js';

export type Db = Pool | PoolClient;

/** Days to keep noop op_id markers for idempotent retries. */
export const GEAR_OP_NOOP_RETENTION_DAYS = 30;

/** Cap per prune pass so a large backlog cannot hold a long lock. */
export const GEAR_OP_NOOP_PRUNE_BATCH = 5_000;

/** Default in-process sweep interval (cheap; table is tiny). */
export const GEAR_OP_NOOP_PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export type PruneNoopResult = { deleted: number };

/**
 * Delete gear_op_noop_ids rows older than the retention window.
 * Safe under BYPASSRLS (migrate / tests) and under tenant RLS when guild context is set
 * (opportunistic path only sees the current guild's rows).
 */
export async function pruneExpiredNoopOpIds(
  db: Db,
  opts?: {
    retentionDays?: number;
    /** Override "now" for tests (timestamptz). */
    now?: Date;
    limit?: number;
  },
): Promise<PruneNoopResult> {
  const days = opts?.retentionDays ?? GEAR_OP_NOOP_RETENTION_DAYS;
  const limit = opts?.limit ?? GEAR_OP_NOOP_PRUNE_BATCH;
  const now = opts?.now ?? new Date();

  // ctid subquery keeps the delete bounded and index-friendly on recorded_at.
  const r = await db.query(
    `DELETE FROM gear_op_noop_ids
     WHERE ctid IN (
       SELECT ctid FROM gear_op_noop_ids
       WHERE recorded_at < $1::timestamptz - make_interval(days => $2)
       LIMIT $3
     )`,
    [now.toISOString(), days, limit],
  );
  return { deleted: r.rowCount ?? 0 };
}

export type NoopRetentionJob = {
  stop: () => void;
};

/**
 * Cheap periodic in-process prune. No external cron/queue.
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
  const retentionDays = opts?.retentionDays ?? GEAR_OP_NOOP_RETENTION_DAYS;
  const log =
    opts?.log ??
    ((msg, err) => {
      if (err !== undefined) console.error(msg, err);
      else console.log(msg);
    });

  const tick = async () => {
    try {
      let total = 0;
      // Drain in batches until a short pass (or empty).
      for (let i = 0; i < 20; i++) {
        const { deleted } = await pruneExpiredNoopOpIds(pool, { retentionDays });
        total += deleted;
        if (deleted < GEAR_OP_NOOP_PRUNE_BATCH) break;
      }
      if (total > 0) log(`gear_op_noop_ids prune deleted=${total} retention_days=${retentionDays}`);
    } catch (err) {
      log('gear_op_noop_ids prune failed', err);
    }
  };

  // Run once shortly after boot, then on the interval.
  const initial = setTimeout(() => {
    void tick();
  }, 15_000);
  const handle = setInterval(() => {
    void tick();
  }, intervalMs);
  // Don't keep the event loop alive solely for prune (tests / short CLI).
  if (typeof initial.unref === 'function') initial.unref();
  if (typeof handle.unref === 'function') handle.unref();

  return {
    stop: () => {
      clearTimeout(initial);
      clearInterval(handle);
    },
  };
}
