import type { Pool } from '../db/pool.js';
import { createHash } from 'node:crypto';

export type PublicRateBucket = 'list_detail' | 'sitemap';

const LIMITS: Record<PublicRateBucket, { limit: number; windowSec: number }> = {
  list_detail: { limit: 120, windowSec: 60 },
  sitemap: { limit: 30, windowSec: 60 },
};

export function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

export type RateCheck = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSec: number;
  retryAfterSec: number;
};

/**
 * Fixed-window per-IP rate limit stored in public_api_rate_limits.
 */
export async function checkPublicRateLimit(
  db: Pool,
  ip: string,
  bucket: PublicRateBucket,
): Promise<RateCheck> {
  const cfg = LIMITS[bucket];
  const ipHash = hashIp(ip || 'unknown');
  const res = await db.query<{ window_start: Date; hit_count: number }>(
    `INSERT INTO public_api_rate_limits (ip_hash, bucket, window_start, hit_count)
     VALUES ($1, $2, now(), 1)
     ON CONFLICT (ip_hash, bucket) DO UPDATE SET
       window_start = CASE
         WHEN public_api_rate_limits.window_start <= now() - make_interval(secs => $3)
         THEN now()
         ELSE public_api_rate_limits.window_start
       END,
       hit_count = CASE
         WHEN public_api_rate_limits.window_start <= now() - make_interval(secs => $3)
         THEN 1
         ELSE public_api_rate_limits.hit_count + 1
       END
     RETURNING window_start, hit_count`,
    [ipHash, bucket, cfg.windowSec],
  );
  const row = res.rows[0]!;
  const elapsedMs = Date.now() - new Date(row.window_start).getTime();
  const resetSec = Math.max(1, cfg.windowSec - Math.floor(elapsedMs / 1000));
  const allowed = row.hit_count <= cfg.limit;
  return {
    allowed,
    limit: cfg.limit,
    remaining: Math.max(0, cfg.limit - row.hit_count),
    resetSec,
    retryAfterSec: allowed ? 0 : resetSec,
  };
}

export async function clearPublicRateLimits(db: Pool): Promise<void> {
  await db.query(`DELETE FROM public_api_rate_limits`);
}
