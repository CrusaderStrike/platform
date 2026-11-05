import type { Pool, PoolClient } from '../db/pool.js';
import { createHash } from 'node:crypto';
import type { BlizzardRegion } from '../blizzard/regions.js';
import { getForeverRealm, isForeverRealmSlug, isValidSlug } from './realms.js';

export type Db = Pool | PoolClient;

export type PublicGuildRow = {
  id: string;
  name: string;
  region: BlizzardRegion;
  realm_slug: string;
  realm_name: string;
  guild_slug: string;
  faction: 'alliance' | 'horde';
  recruiting: boolean;
  open_roles: string[];
  pitch: string | null;
  recruiting_needs: unknown;
  raid_schedule: unknown;
  raid_timezone: string | null;
  contact: unknown;
  public_member_count: number | null;
  emblem_url: string | null;
  updated_at: Date;
  version: number;
};

export type ListFilters = {
  regions?: BlizzardRegion[];
  realm?: string;
  faction?: 'alliance' | 'horde';
  role?: 'tank' | 'healer' | 'dps';
  class?: string;
  cursor?: string;
  limit: number;
};

type CursorPayload = { u: string; i: string };

export function encodeCursor(updatedAt: Date, id: string): string {
  const payload: CursorPayload = { u: updatedAt.toISOString(), i: id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as CursorPayload;
    if (!parsed || typeof parsed.u !== 'string' || typeof parsed.i !== 'string') return null;
    if (Number.isNaN(Date.parse(parsed.u))) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function etagForGuild(row: Pick<PublicGuildRow, 'id' | 'updated_at' | 'version'>): string {
  const raw = `${row.id}:${row.version}:${new Date(row.updated_at).toISOString()}`;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return `"${hash}"`;
}

const FOREVER_CLASSES = new Set([
  'warrior',
  'paladin',
  'hunter',
  'rogue',
  'priest',
  'shaman',
  'mage',
  'warlock',
  'druid',
]);

export function isForeverClass(value: string): boolean {
  return FOREVER_CLASSES.has(value.toLowerCase());
}

const IANA_ZONES = new Set(Intl.supportedValuesOf('timeZone'));

/** True when `tz` is a canonical IANA time zone name (e.g. America/Los_Angeles). */
export function isIanaTimeZone(tz: string): boolean {
  return IANA_ZONES.has(tz);
}

/** Strong ETag from page payload bytes (list / sitemap). */
export function etagForPage(kind: string, body: unknown): string {
  const raw = `${kind}:${JSON.stringify(body)}`;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return `"${hash}"`;
}

function mapRow(r: PublicGuildRow): PublicGuildRow {
  return {
    ...r,
    open_roles: Array.isArray(r.open_roles) ? r.open_roles : [],
    updated_at: new Date(r.updated_at),
  };
}

export function toSummary(row: PublicGuildRow) {
  const realm = getForeverRealm(row.region, row.realm_slug);
  return {
    region: row.region,
    realm_slug: row.realm_slug,
    realm_name: row.realm_name || realm?.name || row.realm_slug,
    guild_slug: row.guild_slug,
    name: row.name,
    faction: row.faction,
    recruiting: row.recruiting,
    open_roles: row.open_roles,
    updated_at: row.updated_at.toISOString(),
  };
}

export function toDetail(row: PublicGuildRow) {
  return {
    ...toSummary(row),
    pitch: row.pitch ?? '',
    recruiting_needs: Array.isArray(row.recruiting_needs) ? row.recruiting_needs : [],
    raid_schedule: Array.isArray(row.raid_schedule) ? row.raid_schedule : [],
    // No UTC fallback — officer write path must set a real IANA zone before listing.
    raid_timezone: row.raid_timezone,
    contact: row.contact ?? { type: 'in_game', value: row.name },
    // Officer-set only; null means unset (never coalesce to 0 / roster count).
    member_count: row.public_member_count,
    emblem_url: null as string | null,
  };
}

const SELECT_COLS = `id, name, region, realm_slug, realm_name, guild_slug, faction, recruiting,
            open_roles, pitch, recruiting_needs, raid_schedule, raid_timezone,
            contact, public_member_count, emblem_url, updated_at, version`;

export async function listPublicGuilds(
  db: Db,
  filters: ListFilters,
): Promise<{ items: PublicGuildRow[]; next_cursor: string | null }> {
  const where: string[] = [`kind = 'guild'`, `public_listed = true`];
  const params: unknown[] = [];

  if (filters.regions && filters.regions.length > 0) {
    params.push(filters.regions);
    where.push(`region = ANY($${params.length}::text[])`);
  }
  if (filters.realm) {
    params.push(filters.realm);
    where.push(`realm_slug = $${params.length}`);
  }
  if (filters.faction) {
    params.push(filters.faction);
    where.push(`faction = $${params.length}`);
  }
  if (filters.role && !filters.class) {
    params.push(filters.role);
    where.push(`$${params.length} = ANY(open_roles)`);
  }
  if (filters.class && filters.role) {
    params.push(filters.class.toLowerCase());
    params.push(filters.role);
    where.push(
      `EXISTS (
         SELECT 1 FROM jsonb_array_elements(recruiting_needs) AS n
         WHERE lower(n->>'class') = $${params.length - 1}
           AND lower(n->>'role') = $${params.length}
       )`,
    );
  } else if (filters.class) {
    params.push(filters.class.toLowerCase());
    where.push(
      `EXISTS (
         SELECT 1 FROM jsonb_array_elements(recruiting_needs) AS n
         WHERE lower(n->>'class') = $${params.length}
       )`,
    );
  }

  if (filters.cursor) {
    const c = decodeCursor(filters.cursor);
    if (!c) throw new Error('bad_cursor');
    params.push(c.u, c.i);
    where.push(
      `(updated_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
    );
  }

  params.push(filters.limit + 1);
  const res = await db.query<PublicGuildRow>(
    `SELECT ${SELECT_COLS}
     FROM guilds
     WHERE ${where.join(' AND ')}
     ORDER BY updated_at DESC, id DESC
     LIMIT $${params.length}`,
    params,
  );
  const rows = res.rows.map(mapRow);
  let next_cursor: string | null = null;
  if (rows.length > filters.limit) {
    const last = rows[filters.limit - 1]!;
    next_cursor = encodeCursor(last.updated_at, last.id);
    rows.length = filters.limit;
  }
  return { items: rows, next_cursor };
}

export async function getPublicGuild(
  db: Db,
  region: BlizzardRegion,
  realmSlug: string,
  guildSlug: string,
): Promise<PublicGuildRow | null> {
  if (!isValidSlug(realmSlug) || !isValidSlug(guildSlug)) return null;
  if (!isForeverRealmSlug(region, realmSlug)) return null;
  const res = await db.query<PublicGuildRow>(
    `SELECT ${SELECT_COLS}
     FROM guilds
     WHERE kind = 'guild'
       AND public_listed = true
       AND region = $1
       AND realm_slug = $2
       AND guild_slug = $3
     LIMIT 1`,
    [region, realmSlug, guildSlug],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

export async function listPublicSitemap(
  db: Db,
  opts: { cursor?: string; limit: number },
): Promise<{
  items: {
    region: BlizzardRegion;
    realm_slug: string;
    guild_slug: string;
    updated_at: Date;
    id: string;
  }[];
  next_cursor: string | null;
}> {
  const params: unknown[] = [];
  const where = [`kind = 'guild'`, `public_listed = true`];
  if (opts.cursor) {
    const c = decodeCursor(opts.cursor);
    if (!c) throw new Error('bad_cursor');
    params.push(c.u, c.i);
    where.push(`(updated_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(opts.limit + 1);
  const res = await db.query<{
    id: string;
    region: BlizzardRegion;
    realm_slug: string;
    guild_slug: string;
    updated_at: Date;
  }>(
    `SELECT id, region, realm_slug, guild_slug, updated_at
     FROM guilds
     WHERE ${where.join(' AND ')}
     ORDER BY updated_at DESC, id DESC
     LIMIT $${params.length}`,
    params,
  );
  const rows = res.rows.map((r) => ({
    ...r,
    updated_at: new Date(r.updated_at),
  }));
  let next_cursor: string | null = null;
  if (rows.length > opts.limit) {
    const last = rows[opts.limit - 1]!;
    next_cursor = encodeCursor(last.updated_at, last.id);
    rows.length = opts.limit;
  }
  return { items: rows, next_cursor };
}
