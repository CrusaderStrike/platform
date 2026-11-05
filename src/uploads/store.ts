import type { Pool, PoolClient } from '../db/pool.js';
import type { BattlegroundIn, DungeonRunIn, WorldPvpIn } from './schema.js';
import { STATUS_RANK, normalizeRealmSql } from './schema.js';

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
  selection: { displayed_character_ids: string[] } | null,
): Set<string> {
  if (!selection) return new Set();
  return new Set(selection.displayed_character_ids ?? []);
}

/**
 * Resolve character by realm + name. Realm match uses normalizeRealmSql
 * (spaces/hyphens/apostrophes stripped, case-insensitive).
 */
export async function findCharacterByRealmName(
  db: Db,
  userId: string,
  realm: string,
  name: string,
): Promise<{ id: string; character_name: string; realm: string | null } | null> {
  const realmNorm = normalizeRealmSql('realm');
  const paramNorm = normalizeRealmSql('$3');
  const res = await db.query<{ id: string; character_name: string; realm: string | null }>(
    `SELECT id, character_name, realm FROM characters
     WHERE user_id = $1
       AND lower(character_name) = lower($2)
       AND realm IS NOT NULL
       AND ${realmNorm} = ${paramNorm}
     LIMIT 1`,
    [userId, name, realm],
  );
  return res.rows[0] ?? null;
}

/**
 * Upsert dungeon run. Dedupe key: (character_id, addon_run_id).
 *
 * Rules:
 * - Status moves forward only (in_progress → closed → completed); never backward.
 * - A still-in_progress re-upload refreshes party/bosses/deaths/raw_payload (and related fields).
 * - guild_id always updates to the caller's current upload guild on re-upload (same as PvP).
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

  const existing = await db.query<{ status: 'in_progress' | 'closed' | 'completed'; guild_id: string }>(
    `SELECT status, guild_id FROM dungeon_runs
     WHERE character_id = $1 AND addon_run_id = $2`,
    [args.characterId, run.addonRunId],
  );

  if (!existing.rows[0]) {
    await db.query(
      `INSERT INTO dungeon_runs (
         guild_id, user_id, character_id, addon_run_id, schema_version, game_version,
         dungeon_id, dungeon_name, difficulty, started_at, completed_at, duration_ms,
         completed, status, party, bosses, deaths, raw_payload
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb
       )`,
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
      ],
    );
    return 'accepted';
  }

  const prev = existing.rows[0];
  const oldRank = STATUS_RANK[prev.status];
  const forward = newRank > oldRank;
  const refreshInProgress = prev.status === 'in_progress' && run.status === 'in_progress';
  const guildChanged = prev.guild_id !== args.guildId;

  if (!forward && !refreshInProgress && !guildChanged) {
    return 'duplicate';
  }

  if (forward || refreshInProgress) {
    // Full field refresh; status only advances on forward.
    await db.query(
      `UPDATE dungeon_runs SET
         guild_id = $1,
         user_id = $2,
         schema_version = $3,
         game_version = $4,
         dungeon_id = $5,
         dungeon_name = $6,
         difficulty = $7,
         started_at = $8,
         completed_at = $9,
         duration_ms = $10,
         completed = $11,
         status = $12,
         party = $13::jsonb,
         bosses = $14::jsonb,
         deaths = $15::jsonb,
         raw_payload = $16::jsonb,
         updated_at = now()
       WHERE character_id = $17 AND addon_run_id = $18`,
      [
        args.guildId,
        args.userId,
        run.schemaVersion,
        run.gameVersion,
        run.instance.id,
        run.instance.name,
        run.instance.difficultyName ?? null,
        unixToDate(run.startedAt),
        unixToDate(run.endedAt ?? null),
        durationMs,
        run.completed,
        forward ? run.status : prev.status,
        JSON.stringify(run.party),
        JSON.stringify(run.bosses),
        JSON.stringify(run.deaths),
        JSON.stringify(run),
        args.characterId,
        run.addonRunId,
      ],
    );
    return 'accepted';
  }

  // Guild-only re-upload: move tenancy, do not count as a new accept.
  await db.query(
    `UPDATE dungeon_runs SET guild_id = $1, user_id = $2, updated_at = now()
     WHERE character_id = $3 AND addon_run_id = $4`,
    [args.guildId, args.userId, args.characterId, run.addonRunId],
  );
  return 'duplicate';
}

/**
 * Insert world PvP. Dedupe (character_id, addon_pvp_id).
 * On re-upload, guild_id always updates to the caller's current upload guild.
 */
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
         guild_id = EXCLUDED.guild_id,
         user_id = EXCLUDED.user_id
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
  return res.rows[0]!.inserted ? 'accepted' : 'duplicate';
}

/**
 * Insert battleground. Dedupe (character_id, addon_pvp_id).
 * On re-upload, guild_id always updates to the caller's current upload guild.
 */
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
         guild_id = EXCLUDED.guild_id,
         user_id = EXCLUDED.user_id
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
