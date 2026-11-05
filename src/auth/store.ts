import type { Pool, PoolClient } from '../db/pool.js';
import type { NormalizedCharacter } from '../blizzard/types.js';
import { randomToken } from '../lib/crypto.js';

export type Db = Pool | PoolClient;

export type UserRow = {
  id: string;
  battlenet_id: string;
  battletag: string;
  preferred_region: 'us' | 'eu' | 'kr' | 'tw'
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: Date | null;
  last_refreshed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type SessionRow = {
  id: string;
  user_id: string;
  csrf_token: string;
  active_guild_id: string | null;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
};

export type CharacterRow = {
  id: string;
  user_id: string;
  blizzard_char_id: string | null;
  character_name: string;
  surname: string | null;
  realm: string | null;
  realm_id: number | null;
  region: 'us' | 'eu' | 'kr' | 'tw'
  faction: 'alliance' | 'horde' | null;
  class: string | null;
  race: string | null;
  level: number | null;
  game: 'wow_forever';
  stale: boolean;
  displayed: boolean;
  updated_at: Date;
};

export type SelectionRow = {
  user_id: string;
  displayed_character_ids: string[];
  /** Compat main — persisted in character_selections.main_id while still displayed. */
  main_id: string | null;
  updated_at: Date | null;
};

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function saveOauthState(
  db: Db,
  args: { state: string; codeVerifier: string; returnTo: string; ttlMs?: number },
): Promise<void> {
  const expires = new Date(Date.now() + (args.ttlMs ?? 10 * 60 * 1000));
  await db.query(
    `INSERT INTO oauth_states (state, code_verifier, return_to, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (state) DO UPDATE SET code_verifier = EXCLUDED.code_verifier,
       return_to = EXCLUDED.return_to, expires_at = EXCLUDED.expires_at`,
    [args.state, args.codeVerifier, args.returnTo, expires],
  );
}

export async function takeOauthState(
  db: Db,
  state: string,
): Promise<{ codeVerifier: string; returnTo: string } | null> {
  const res = await db.query<{ code_verifier: string; return_to: string; expires_at: Date }>(
    `DELETE FROM oauth_states WHERE state = $1 RETURNING code_verifier, return_to, expires_at`,
    [state],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (row.expires_at.getTime() < Date.now()) return null;
  return { codeVerifier: row.code_verifier, returnTo: row.return_to };
}

export async function upsertUserFromBattleNet(
  db: Db,
  args: {
    battlenetId: string;
    battletag: string;
    accessToken: string;
    refreshToken?: string | null;
    expiresIn?: number;
    preferredRegion?: 'us' | 'eu' | 'kr' | 'tw'
  },
): Promise<UserRow> {
  const expiresAt = args.expiresIn
    ? new Date(Date.now() + args.expiresIn * 1000)
    : null;
  const res = await db.query<UserRow>(
    `INSERT INTO users (battlenet_id, battletag, access_token, refresh_token, token_expires_at, preferred_region)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (battlenet_id) DO UPDATE SET
       battletag = EXCLUDED.battletag,
       access_token = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, users.refresh_token),
       token_expires_at = EXCLUDED.token_expires_at,
       updated_at = now()
     RETURNING *`,
    [
      args.battlenetId,
      args.battletag,
      args.accessToken,
      args.refreshToken ?? null,
      expiresAt,
      args.preferredRegion ?? 'us',
    ],
  );
  return res.rows[0]!;
}

export async function createSession(db: Db, userId: string): Promise<SessionRow> {
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  const res = await db.query<SessionRow>(
    `INSERT INTO sessions (user_id, csrf_token, expires_at) VALUES ($1, $2, $3) RETURNING *`,
    [userId, csrf, expires],
  );
  return res.rows[0]!;
}

export async function getSession(db: Db, sessionId: string): Promise<(SessionRow & { battletag: string; preferred_region: 'us' | 'eu' | 'kr' | 'tw' }) | null> {
  const res = await db.query<SessionRow & { battletag: string; preferred_region: 'us' | 'eu' | 'kr' | 'tw' }>(
    `SELECT s.*, u.battletag, u.preferred_region
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sessionId],
  );
  return res.rows[0] ?? null;
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [
    sessionId,
  ]);
}

export async function getUser(db: Db, userId: string): Promise<UserRow | null> {
  const res = await db.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [userId]);
  return res.rows[0] ?? null;
}

export async function updatePreferredRegion(
  db: Db,
  userId: string,
  region: 'us' | 'eu' | 'kr' | 'tw',
): Promise<UserRow> {
  const res = await db.query<UserRow>(
    `UPDATE users SET preferred_region = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [userId, region],
  );
  return res.rows[0]!;
}

export async function replaceCharacters(
  db: Pool,
  userId: string,
  chars: NormalizedCharacter[],
): Promise<CharacterRow[]> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const ids = chars.map((c) => c.id);
    if (ids.length) {
      await client.query(
        `UPDATE characters SET stale = true, updated_at = now()
         WHERE user_id = $1 AND NOT (id = ANY($2::text[]))`,
        [userId, ids],
      );
    } else {
      await client.query(
        `UPDATE characters SET stale = true, updated_at = now() WHERE user_id = $1`,
        [userId],
      );
    }
    for (const c of chars) {
      await client.query(
        `INSERT INTO characters (
           id, user_id, blizzard_char_id, character_name, surname, realm, realm_id,
           region, faction, class, race, level, game, stale, raw, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'wow_forever', false, $13, now())
         ON CONFLICT (id) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           blizzard_char_id = EXCLUDED.blizzard_char_id,
           character_name = EXCLUDED.character_name,
           surname = EXCLUDED.surname,
           realm = EXCLUDED.realm,
           realm_id = EXCLUDED.realm_id,
           region = EXCLUDED.region,
           faction = EXCLUDED.faction,
           class = EXCLUDED.class,
           race = EXCLUDED.race,
           level = EXCLUDED.level,
           stale = false,
           raw = EXCLUDED.raw,
           updated_at = now()`,
        [
          c.id,
          userId,
          c.blizzardCharId,
          c.characterName,
          c.surname,
          c.realm,
          c.realmId,
          c.region,
          c.faction,
          c.class,
          c.race,
          c.level,
          JSON.stringify(c.raw),
        ],
      );
    }
    // Stale characters leave the display set (new chars keep displayed=false default).
    await client.query(
      `UPDATE characters SET displayed = false
       WHERE user_id = $1 AND stale = true AND displayed = true`,
      [userId],
    );
    // Preserve persisted main / client order via the shared mirror helper.
    await resyncSelectionMirror(client, userId);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const res = await db.query<CharacterRow>(
    `SELECT * FROM characters WHERE user_id = $1 ORDER BY character_name, surname NULLS LAST`,
    [userId],
  );
  return res.rows;
}

export async function listCharacters(db: Db, userId: string): Promise<CharacterRow[]> {
  const res = await db.query<CharacterRow>(
    `SELECT * FROM characters WHERE user_id = $1 ORDER BY character_name, surname NULLS LAST`,
    [userId],
  );
  return res.rows;
}

type SelectionMirrorRow = {
  main_id: string | null;
  alt_ids: string[];
  displayed_character_ids: string[];
  updated_at: Date;
};

async function readSelectionMirror(db: Db, userId: string): Promise<SelectionMirrorRow | null> {
  const res = await db.query<SelectionMirrorRow>(
    `SELECT main_id, alt_ids, displayed_character_ids, updated_at
     FROM character_selections WHERE user_id = $1`,
    [userId],
  );
  return res.rows[0] ?? null;
}

/**
 * Mirror display set into character_selections (kept one release for rollback).
 * `ids` keeps client order; `mainId` is the chosen main when still in `ids`.
 */
async function syncSelectionMirror(
  db: Db,
  userId: string,
  ids: string[],
  mainId: string | null,
): Promise<void> {
  if (ids.length === 0) {
    await db.query(`DELETE FROM character_selections WHERE user_id = $1`, [userId]);
    return;
  }
  const main = mainId && ids.includes(mainId) ? mainId : ids[0]!;
  const alts = ids.filter((id) => id !== main);
  await db.query(
    `INSERT INTO character_selections (user_id, main_id, alt_ids, displayed_character_ids, updated_at)
     VALUES ($1, $2, $3::text[], $4::text[], now())
     ON CONFLICT (user_id) DO UPDATE SET
       main_id = EXCLUDED.main_id,
       alt_ids = EXCLUDED.alt_ids,
       displayed_character_ids = EXCLUDED.displayed_character_ids,
       updated_at = now()`,
    [userId, main, alts, ids],
  );
}

/** Rebuild mirror from live displayed flags, keeping persisted main + prior order when possible. */
async function resyncSelectionMirror(db: Db, userId: string): Promise<SelectionRow> {
  const selection = await getSelection(db, userId);
  await syncSelectionMirror(db, userId, selection.displayed_character_ids, selection.main_id);
  return getSelection(db, userId);
}

/**
 * Always returns a selection object (empty array when nothing is displayed).
 * Order and main_id come from character_selections when still valid; never sorted by name.
 */
export async function getSelection(db: Db, userId: string): Promise<SelectionRow> {
  const liveRes = await db.query<{ id: string }>(
    `SELECT id FROM characters
     WHERE user_id = $1 AND displayed = true AND stale = false`,
    [userId],
  );
  const liveSet = new Set(liveRes.rows.map((r) => r.id));
  if (liveSet.size === 0) {
    return {
      user_id: userId,
      displayed_character_ids: [],
      main_id: null,
      updated_at: null,
    };
  }

  const mirror = await readSelectionMirror(db, userId);
  const order: string[] = [];
  if (mirror) {
    for (const id of mirror.displayed_character_ids ?? []) {
      if (liveSet.has(id) && !order.includes(id)) order.push(id);
    }
  }
  for (const id of liveSet) {
    if (!order.includes(id)) order.push(id);
  }

  let mainId: string | null = null;
  if (mirror?.main_id && liveSet.has(mirror.main_id)) {
    mainId = mirror.main_id;
  } else {
    mainId = order[0] ?? null;
  }

  return {
    user_id: userId,
    displayed_character_ids: order,
    main_id: mainId,
    updated_at: mirror?.updated_at ?? null,
  };
}

/** Replace-all display set. Ids must already be validated as owned Forever live chars. */
export async function setSelection(
  db: Db,
  args: {
    userId: string;
    displayedCharacterIds: string[];
    /** Explicit compat main; defaults to first id in the sent list. */
    mainId?: string | null;
  },
): Promise<SelectionRow> {
  const ids = args.displayedCharacterIds;
  // Do not bump characters.updated_at — that timestamp is for Blizzard refresh.
  await db.query(
    `UPDATE characters SET displayed = (id = ANY($2::text[]))
     WHERE user_id = $1`,
    [args.userId, ids],
  );
  let main: string | null;
  if (args.mainId !== undefined) {
    main = args.mainId && ids.includes(args.mainId) ? args.mainId : ids[0] ?? null;
  } else {
    main = ids[0] ?? null;
  }
  await syncSelectionMirror(db, args.userId, ids, main);
  return getSelection(db, args.userId);
}

/** Toggle one character's displayed flag (primary UI path). Does not bump updated_at. */
export async function setCharacterDisplayed(
  db: Db,
  args: { userId: string; characterId: string; displayed: boolean },
): Promise<CharacterRow | null> {
  const mirror = await readSelectionMirror(db, args.userId);
  const res = await db.query<CharacterRow>(
    `UPDATE characters SET displayed = $3
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [args.characterId, args.userId, args.displayed],
  );
  const row = res.rows[0] ?? null;
  if (!row) return null;

  // Preserve prior client order; append on show, drop on hide. Keep main if still displayed.
  const prior = (mirror?.displayed_character_ids ?? []).filter((id) => id !== args.characterId);
  const ids = args.displayed ? [...prior, args.characterId] : prior;
  const main =
    mirror?.main_id && ids.includes(mirror.main_id) ? mirror.main_id : ids[0] ?? null;
  await syncSelectionMirror(db, args.userId, ids, main);
  return row;
}

export async function getCharacterForUser(
  db: Db,
  userId: string,
  characterId: string,
): Promise<CharacterRow | null> {
  const res = await db.query<CharacterRow>(
    `SELECT * FROM characters WHERE id = $1 AND user_id = $2`,
    [characterId, userId],
  );
  return res.rows[0] ?? null;
}

export async function getCharacterGear(
  db: Db,
  characterId: string,
): Promise<{ character_id: string; items: unknown[]; updated_at: Date } | null> {
  const res = await db.query<{ character_id: string; items: unknown; updated_at: Date }>(
    `SELECT character_id, items, updated_at FROM character_gear WHERE character_id = $1`,
    [characterId],
  );
  const row = res.rows[0];
  if (!row) return { character_id: characterId, items: [], updated_at: new Date(0) };
  const items = Array.isArray(row.items) ? row.items : [];
  return { character_id: row.character_id, items, updated_at: row.updated_at };
}

export async function putCharacterGear(
  db: Db,
  characterId: string,
  items: unknown[],
): Promise<{ character_id: string; items: unknown[]; updated_at: Date }> {
  const res = await db.query<{ character_id: string; items: unknown; updated_at: Date }>(
    `INSERT INTO character_gear (character_id, items, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (character_id) DO UPDATE SET items = EXCLUDED.items, updated_at = now()
     RETURNING character_id, items, updated_at`,
    [characterId, JSON.stringify(items)],
  );
  const row = res.rows[0]!;
  return {
    character_id: row.character_id,
    items: Array.isArray(row.items) ? row.items : [],
    updated_at: row.updated_at,
  };
}


export async function getLastRefreshedAt(db: Db, userId: string): Promise<Date | null> {
  const res = await db.query<{ last_refreshed_at: Date | null }>(
    `SELECT last_refreshed_at FROM users WHERE id = $1`,
    [userId],
  );
  return res.rows[0]?.last_refreshed_at ?? null;
}

export async function touchLastRefreshed(db: Db, userId: string): Promise<Date> {
  const res = await db.query<{ last_refreshed_at: Date }>(
    `UPDATE users SET last_refreshed_at = now(), updated_at = now() WHERE id = $1
     RETURNING last_refreshed_at`,
    [userId],
  );
  return res.rows[0]!.last_refreshed_at;
}

export async function clearLastRefreshed(db: Db, userId: string): Promise<void> {
  await db.query(`UPDATE users SET last_refreshed_at = NULL WHERE id = $1`, [userId]);
}


export async function clearUserTokens(db: Db, userId: string): Promise<void> {
  await db.query(
    `UPDATE users SET access_token = NULL, refresh_token = NULL, token_expires_at = NULL, updated_at = now()
     WHERE id = $1`,
    [userId],
  );
}

export async function getCachedItemIcon(
  db: Db,
  itemId: number,
  region: string,
): Promise<{ icon_url: string | null; icon_name: string | null } | null> {
  const res = await db.query<{ icon_url: string | null; icon_name: string | null }>(
    `SELECT icon_url, icon_name FROM item_icon_cache WHERE item_id = $1 AND region = $2`,
    [itemId, region],
  );
  return res.rows[0] ?? null;
}

export async function upsertCachedItemIcon(
  db: Db,
  args: { itemId: number; region: string; iconUrl: string | null; iconName: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO item_icon_cache (item_id, region, icon_url, icon_name, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (item_id, region) DO UPDATE SET
       icon_url = EXCLUDED.icon_url,
       icon_name = EXCLUDED.icon_name,
       updated_at = now()`,
    [args.itemId, args.region, args.iconUrl, args.iconName],
  );
}

export function characterToApi(c: CharacterRow) {
  return {
    id: c.id,
    character_name: c.character_name,
    surname: c.surname,
    realm: c.realm,
    region: c.region,
    faction: c.faction,
    class: c.class,
    race: c.race,
    level: c.level,
    game: 'wow_forever' as const,
    stale: c.stale,
    displayed: c.displayed,
  };
}

export function selectionToApi(s: SelectionRow) {
  const ids = s.displayed_character_ids ?? [];
  const mainId = s.main_id && ids.includes(s.main_id) ? s.main_id : ids[0] ?? null;
  return {
    displayed_character_ids: ids,
    // Compat for live web until web#43 ships.
    main_id: mainId,
    alt_ids: ids.filter((id) => id !== mainId),
    updated_at: s.updated_at ? s.updated_at.toISOString() : null,
  };
}
