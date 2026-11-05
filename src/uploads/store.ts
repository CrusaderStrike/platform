import type { Pool, PoolClient } from '../db/pool.js';
import type { BattlegroundIn, DungeonRunIn, WorldPvpIn } from './schema.js';

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

export async function insertDungeonRun(
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
  const res = await db.query(
    `INSERT INTO dungeon_runs (
       guild_id, user_id, character_id, addon_run_id, schema_version, game_version,
       dungeon_id, dungeon_name, difficulty, started_at, completed_at, duration_ms,
       completed, status, party, bosses, deaths, raw_payload
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb
     )
     ON CONFLICT (guild_id, character_id, addon_run_id) DO NOTHING
     RETURNING id`,
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
  return res.rowCount && res.rowCount > 0 ? 'accepted' : 'duplicate';
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
  const res = await db.query(
    `INSERT INTO pvp_world_events (
       guild_id, user_id, character_id, addon_pvp_id, record_version,
       occurred_at, zone, subzone, result, honorable, killer_source, opponent, raw_payload
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb
     )
     ON CONFLICT (guild_id, character_id, addon_pvp_id) DO NOTHING
     RETURNING id`,
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
  return res.rowCount && res.rowCount > 0 ? 'accepted' : 'duplicate';
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
  const res = await db.query(
    `INSERT INTO pvp_battlegrounds (
       guild_id, user_id, character_id, addon_pvp_id, record_version,
       map_id, map_name, faction, started_at, ended_at, duration_sec,
       result, winner, stats, raw_payload
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb
     )
     ON CONFLICT (guild_id, character_id, addon_pvp_id) DO NOTHING
     RETURNING id`,
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
  return res.rowCount && res.rowCount > 0 ? 'accepted' : 'duplicate';
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
  await db.query(
    `INSERT INTO upload_rate_limits (user_id, last_at) VALUES ($1, now())
     ON CONFLICT (user_id) DO UPDATE SET last_at = now()`,
    [userId],
  );
  return { ok: true };
}

export async function clearUploadRateLimit(db: Db, userId?: string): Promise<void> {
  if (userId) {
    await db.query(`DELETE FROM upload_rate_limits WHERE user_id = $1`, [userId]);
  } else {
    await db.query(`DELETE FROM upload_rate_limits`);
  }
}
