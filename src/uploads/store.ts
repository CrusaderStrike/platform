import type { Pool, PoolClient } from '../db/pool.js';
import type { BattlegroundIn, DungeonRunIn, WorldPvpIn } from './schema.js';
import { STATUS_RANK } from './schema.js';

export type Db = Pool | PoolClient;

function unixToDate(sec: number | null | undefined): Date | null {
  if (sec == null) return null;
  return new Date(sec * 1000);
}

/** Personal guild for a user (created once). Used when session has no active_guild_id. */
export async function ensurePersonalGuild(db: Db, userId: string): Promise<string> {
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM guilds WHERE kind = 'personal' AND owner_user_id = $1 LIMIT 1`,
    [userId],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const ins = await db.query<{ id: string }>(
    `INSERT INTO guilds (name, kind, owner_user_id)
     VALUES ('Personal', 'personal', $1)
     RETURNING id`,
    [userId],
  );
  const guildId = ins.rows[0]!.id;
  await db.query(
    `INSERT INTO guild_members (guild_id, user_id, role)
     VALUES ($1, $2, 'owner')
     ON CONFLICT DO NOTHING`,
    [guildId, userId],
  );
  return guildId;
}

export async function resolveUploadGuildId(
  db: Db,
  userId: string,
  activeGuildId: string | null,
): Promise<string> {
  if (activeGuildId) {
    const mem = await db.query(
      `SELECT 1 FROM guild_members WHERE guild_id = $1 AND user_id = $2`,
      [activeGuildId, userId],
    );
    if (mem.rowCount) return activeGuildId;
  }
  return ensurePersonalGuild(db, userId);
}

export function selectedCharacterIds(
  selection: { main_id: string; alt_ids: string[] } | null,
): Set<string> {
  if (!selection) return new Set();
  return new Set([selection.main_id, ...(selection.alt_ids ?? [])]);
}

export async function findCharacterByRealmName(
  db: Db,
  userId: string,
  realm: string,
  name: string,
): Promise<{ id: string; character_name: string; realm: string | null } | null> {
  const res = await db.query<{ id: string; character_name: string; realm: string | null }>(
    `SELECT id, character_name, realm FROM characters
     WHERE user_id = $1
       AND lower(character_name) = lower($2)
       AND realm IS NOT NULL
       AND lower(realm) = lower($3)
     LIMIT 1`,
    [userId, name, realm],
  );
  return res.rows[0] ?? null;
}

function statusRankSql(column: string): string {
  return `(CASE ${column}
    WHEN 'in_progress' THEN 0
    WHEN 'closed' THEN 1
    WHEN 'completed' THEN 2
    ELSE 0 END)`;
}

/**
 * Upsert dungeon run. Dedupe key: (character_id, addon_run_id) — no guild_id.
 * Status moves forward only (in_progress → closed → completed); never backward.
 * Forward updates count as accepted; no-op / backward re-uploads count as duplicate.
 */
export async function upsertDungeonRun(
  db: Db,
  args: {
    guildId: string;
    userId: string;
    characterId: string;
    run: DungeonRunIn;
  },
): Promise<'accepted' | 'duplicate'> {
  const { run } = args;
  const durationMs = run.durationSec != null ? run.durationSec * 1000 : null;
  const newRank = STATUS_RANK[run.status];
  const oldRank = statusRankSql('dungeon_runs.status');

  const res = await db.query<{ inserted: boolean }>(
    `WITH upsert AS (
       INSERT INTO dungeon_runs (
         guild_id, user_id, character_id, addon_run_id, schema_version, game_version,
         dungeon_id, dungeon_name, difficulty, started_at, completed_at, duration_ms,
         completed, status, party, bosses, deaths, raw_payload
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb
       )
       ON CONFLICT (character_id, addon_run_id) DO UPDATE SET
         guild_id = EXCLUDED.guild_id,
         user_id = EXCLUDED.user_id,
         schema_version = EXCLUDED.schema_version,
         game_version = EXCLUDED.game_version,
         dungeon_id = EXCLUDED.dungeon_id,
         dungeon_name = EXCLUDED.dungeon_name,
         difficulty = EXCLUDED.difficulty,
         started_at = EXCLUDED.started_at,
         completed_at = EXCLUDED.completed_at,
         duration_ms = EXCLUDED.duration_ms,
         completed = EXCLUDED.completed,
         status = EXCLUDED.status,
         party = EXCLUDED.party,
         bosses = EXCLUDED.bosses,
         deaths = EXCLUDED.deaths,
         raw_payload = EXCLUDED.raw_payload,
         updated_at = now()
       WHERE ${oldRank} < $19
       RETURNING (xmax = 0) AS inserted
     )
     SELECT inserted FROM upsert`,
    [
      args.guildId,
      args.userId,
      args.characterId,
      run.addonRunId,
      run.schemaVersion,
      run.gameVersion,
      run.instance.id,
      run.instance.name,
      run.instance.difficultyName ?? null,
      unixToDate(run.startedAt),
      unixToDate(run.endedAt ?? null),
      durationMs,
      run.completed,
      run.status,
      JSON.stringify(run.party),
      JSON.stringify(run.bosses),
      JSON.stringify(run.deaths),
      JSON.stringify(run),
      newRank,
    ],
  );

  if (!res.rowCount) return 'duplicate';
  return 'accepted';
}

export async function insertWorldPvp(
  db: Db,
  args: {
    guildId: string;
    userId: string;
    characterId: string;
    rec: WorldPvpIn;
  },
): Promise<'accepted' | 'duplicate'> {
  const { rec } = args;
  const res = await db.query<{ inserted: boolean }>(
    `WITH upsert AS (
       INSERT INTO pvp_world_events (
         guild_id, user_id, character_id, addon_pvp_id, record_version,
         occurred_at, zone, subzone, result, honorable, killer_source, opponent, raw_payload
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb
       )
       ON CONFLICT (character_id, addon_pvp_id) DO UPDATE SET
         guild_id = EXCLUDED.guild_id
       WHERE pvp_world_events.guild_id IS DISTINCT FROM EXCLUDED.guild_id
       RETURNING (xmax = 0) AS inserted
     )
     SELECT inserted FROM upsert`,
    [
      args.guildId,
      args.userId,
      args.characterId,
      rec.addon_pvp_id,
      rec.v,
      unixToDate(rec.time),
      rec.zone ?? null,
      rec.subzone ?? null,
      rec.result,
      rec.honorable,
      rec.killer_source ?? null,
      JSON.stringify(rec.opponent ?? null),
      JSON.stringify(rec),
    ],
  );
  if (!res.rowCount) return 'duplicate';
  // Guild-only touch still returns a row with inserted=false — count as duplicate (no double-count).
  return res.rows[0]!.inserted ? 'accepted' : 'duplicate';
}

export async function insertBattleground(
  db: Db,
  args: {
    guildId: string;
    userId: string;
    characterId: string;
    rec: BattlegroundIn;
  },
): Promise<'accepted' | 'duplicate'> {
  const { rec } = args;
  const res = await db.query<{ inserted: boolean }>(
    `WITH upsert AS (
       INSERT INTO pvp_battlegrounds (
         guild_id, user_id, character_id, addon_pvp_id, record_version,
         map_id, map_name, faction, started_at, ended_at, duration_sec,
         result, winner, stats, raw_payload
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb
       )
       ON CONFLICT (character_id, addon_pvp_id) DO UPDATE SET
         guild_id = EXCLUDED.guild_id
       WHERE pvp_battlegrounds.guild_id IS DISTINCT FROM EXCLUDED.guild_id
       RETURNING (xmax = 0) AS inserted
     )
     SELECT inserted FROM upsert`,
    [
      args.guildId,
      args.userId,
      args.characterId,
      rec.addon_pvp_id,
      rec.v,
      rec.mapId,
      rec.mapName,
      rec.faction ?? null,
      unixToDate(rec.startedAt),
      unixToDate(rec.endedAt),
      rec.durationSec,
      rec.result,
      rec.winner ?? null,
      JSON.stringify(normalizeBgStats(rec.stats)),
      JSON.stringify(rec),
    ],
  );
  if (!res.rowCount) return 'duplicate';
  return res.rows[0]!.inserted ? 'accepted' : 'duplicate';
}

function normalizeBgStats(
  stats: { honorableKills?: number; deaths?: number; honor?: number } | undefined,
): { honorable_kills: number | null; deaths: number | null; honor: number | null } {
  return {
    honorable_kills: stats?.honorableKills ?? null,
    deaths: stats?.deaths ?? null,
    honor: stats?.honor ?? null,
  };
}

const UPLOAD_COOLDOWN_MS = 5_000;

/** Read-only check; does not burn the window. */
export async function checkUploadRateLimit(
  db: Db,
  userId: string,
): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
  const row = await db.query<{ last_at: Date }>(
    `SELECT last_at FROM upload_rate_limits WHERE user_id = $1`,
    [userId],
  );
  const last = row.rows[0]?.last_at;
  if (last) {
    const retryAfter = Math.ceil((last.getTime() + UPLOAD_COOLDOWN_MS - Date.now()) / 1000);
    if (retryAfter > 0) return { ok: false, retryAfterSec: retryAfter };
  }
  return { ok: true };
}

/** Record cooldown only after a successful upload batch (accepted or duplicate). */
export async function touchUploadRateLimit(db: Db, userId: string): Promise<void> {
  await db.query(
    `INSERT INTO upload_rate_limits (user_id, last_at) VALUES ($1, now())
     ON CONFLICT (user_id) DO UPDATE SET last_at = now()`,
    [userId],
  );
}

export async function clearUploadRateLimit(db: Db, userId?: string): Promise<void> {
  if (userId) {
    await db.query(`DELETE FROM upload_rate_limits WHERE user_id = $1`, [userId]);
  } else {
    await db.query(`DELETE FROM upload_rate_limits`);
  }
}
