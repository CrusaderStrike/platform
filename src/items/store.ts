import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from '../db/pool.js';
import type { GearSlot } from '../gear/schema.js';
import { sanitizeBlizzardIconUrl } from '../lib/icon-url.js';
import { classEquipSql, junkExclusionSql } from './equip-rules.js';
import { isPlayableClass, type PlayableClass } from './playable-classes.js';

export type Db = Pool | PoolClient;

export type ForeverItemRow = {
  item_id: string; // pg bigint
  name: string;
  slot: string;
  slot_aliases: string[];
  inventory_type: string;
  quality: string;
  item_level: number;
  required_level: number;
  armor_type: string | null;
  item_class: number | null;
  item_subclass: number | null;
  allowed_classes: string[] | null;
  item_set_id: number | null;
  /** Present on list/get when joined; effective = item's own or set's. */
  effective_allowed_classes?: string[] | null;
  stats: unknown;
  icon_url: string | null;
  icon_name: string | null;
  source: string;
  verified: boolean;
  region: string;
  imported_at: Date;
  updated_at: Date;
};

export type ForeverItemWire = {
  item_id: number;
  name: string;
  slot: string;
  inventory_type: string;
  quality: string;
  item_level: number;
  required_level: number;
  armor_type: string | null;
  item_class: number | null;
  item_subclass: number | null;
  allowed_classes: string[] | null;
  stats: { type: string; value: number }[] | null;
  icon_url: string | null;
  source: 'blizzard_forever';
  verified: true;
};

export type ItemStat = { type: string; value: number };

export type UpsertItemInput = {
  itemId: number;
  name: string;
  slot: string;
  slotAliases: string[];
  inventoryType: string;
  quality: string;
  itemLevel: number;
  requiredLevel: number;
  armorType: string | null;
  itemClass: number | null;
  itemSubclass: number | null;
  allowedClasses?: string[] | null;
  itemSetId?: number | null;
  stats: ItemStat[] | null;
  iconUrl: string | null;
  iconName: string | null;
  region: string;
};

export type ListItemsFilters = {
  slot?: GearSlot;
  /** Playable class filter (warrior|…|druid) — applies full equip rules. */
  playableClass?: string;
  /** armor_type filter (cloth|leather|mail|plate). */
  armorType?: string;
  q?: string;
  minItemLevel?: number;
  maxRequiredLevel?: number;
  cursor?: string;
  limit?: number;
  /** When false, skip junk-name exclusion. Default true. */
  excludeJunk?: boolean;
};

export type ForeverItemsMeta = {
  build_id: string;
  item_count: number;
  set_count: number;
  region: string;
  imported_at: Date;
  updated_at: Date;
};

function encodeCursor(itemId: number): string {
  return Buffer.from(JSON.stringify({ i: itemId }), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): number | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { i?: unknown };
    if (typeof parsed.i !== 'number' || !Number.isInteger(parsed.i) || parsed.i < 1) return null;
    return parsed.i;
  } catch {
    return null;
  }
}

function mapStats(raw: unknown): ItemStat[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ItemStat[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const type = (s as { type?: unknown }).type;
    const value = (s as { value?: unknown }).value;
    if (typeof type === 'string' && typeof value === 'number') {
      out.push({ type, value });
    }
  }
  return out.length ? out : null;
}

export function effectiveAllowedClasses(row: ForeverItemRow): string[] | null {
  const own = row.allowed_classes;
  if (own && own.length > 0) return own;
  const eff = row.effective_allowed_classes;
  if (eff && eff.length > 0) return eff;
  return own && own.length === 0 ? [] : eff ?? own ?? null;
}

export function toWire(row: ForeverItemRow): ForeverItemWire {
  const allowed = effectiveAllowedClasses(row);
  return {
    item_id: Number(row.item_id),
    name: row.name,
    slot: row.slot,
    inventory_type: row.inventory_type,
    quality: row.quality,
    item_level: row.item_level,
    required_level: row.required_level,
    armor_type: row.armor_type,
    item_class: row.item_class,
    item_subclass: row.item_subclass,
    allowed_classes: allowed && allowed.length > 0 ? allowed : null,
    stats: mapStats(row.stats),
    icon_url: sanitizeBlizzardIconUrl(row.icon_url),
    source: 'blizzard_forever',
    verified: true,
  };
}

export async function getMeta(db: Db): Promise<ForeverItemsMeta> {
  const res = await db.query<ForeverItemsMeta>(
    `SELECT build_id, item_count, COALESCE(set_count, 0)::int AS set_count, region, imported_at, updated_at
     FROM forever_items_meta WHERE id = 1`,
  );
  return (
    res.rows[0] ?? {
      build_id: 'empty',
      item_count: 0,
      set_count: 0,
      region: 'us',
      imported_at: new Date(0),
      updated_at: new Date(0),
    }
  );
}

export async function countItems(db: Db): Promise<number> {
  const res = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM forever_items`);
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * True only after a completed import wrote forever_items_meta (setMeta).
 * Mid-import upserts must not turn on item_not_forever enforcement.
 */
export async function catalogIsActive(db: Db): Promise<boolean> {
  const meta = await getMeta(db);
  return meta.build_id !== 'empty';
}

export async function itemExists(db: Db, itemId: number): Promise<boolean> {
  const res = await db.query(`SELECT 1 FROM forever_items WHERE item_id = $1`, [itemId]);
  return (res.rowCount ?? 0) > 0;
}

export async function getItem(db: Db, itemId: number): Promise<ForeverItemRow | null> {
  const res = await db.query<ForeverItemRow>(
    `SELECT i.*,
            COALESCE(
              NULLIF(i.allowed_classes, '{}'),
              s.allowed_classes
            ) AS effective_allowed_classes
     FROM forever_items i
     LEFT JOIN forever_item_sets s ON s.id = i.item_set_id
     WHERE i.item_id = $1`,
    [itemId],
  );
  return res.rows[0] ?? null;
}

export async function upsertItem(db: Db, input: UpsertItemInput): Promise<void> {
  await db.query(
    `INSERT INTO forever_items (
       item_id, name, slot, slot_aliases, inventory_type, quality, item_level, required_level,
       armor_type, item_class, item_subclass, allowed_classes, item_set_id,
       stats, icon_url, icon_name, source, verified, region,
       imported_at, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,
       $9,$10,$11,$12,$13,
       $14::jsonb,$15,$16,'blizzard_forever',TRUE,$17,
       now(), now()
     )
     ON CONFLICT (item_id) DO UPDATE SET
       name = EXCLUDED.name,
       slot = EXCLUDED.slot,
       slot_aliases = EXCLUDED.slot_aliases,
       inventory_type = EXCLUDED.inventory_type,
       quality = EXCLUDED.quality,
       item_level = EXCLUDED.item_level,
       required_level = EXCLUDED.required_level,
       armor_type = EXCLUDED.armor_type,
       item_class = EXCLUDED.item_class,
       item_subclass = EXCLUDED.item_subclass,
       allowed_classes = EXCLUDED.allowed_classes,
       item_set_id = EXCLUDED.item_set_id,
       stats = EXCLUDED.stats,
       icon_url = EXCLUDED.icon_url,
       icon_name = EXCLUDED.icon_name,
       source = 'blizzard_forever',
       verified = TRUE,
       region = EXCLUDED.region,
       updated_at = now()`,
    [
      input.itemId,
      input.name,
      input.slot,
      input.slotAliases,
      input.inventoryType,
      input.quality,
      input.itemLevel,
      input.requiredLevel,
      input.armorType,
      input.itemClass,
      input.itemSubclass,
      input.allowedClasses ?? null,
      input.itemSetId ?? null,
      JSON.stringify(input.stats),
      sanitizeBlizzardIconUrl(input.iconUrl),
      input.iconName,
      input.region,
    ],
  );
}

export async function setMeta(
  db: Db,
  args: { buildId: string; itemCount: number; region: string; setCount?: number },
): Promise<void> {
  await db.query(
    `INSERT INTO forever_items_meta (id, build_id, item_count, set_count, region, imported_at, updated_at)
     VALUES (1, $1, $2, $3, $4, now(), now())
     ON CONFLICT (id) DO UPDATE SET
       build_id = EXCLUDED.build_id,
       item_count = EXCLUDED.item_count,
       set_count = EXCLUDED.set_count,
       region = EXCLUDED.region,
       imported_at = now(),
       updated_at = now()`,
    [args.buildId, args.itemCount, args.setCount ?? 0, args.region],
  );
}

export type UpsertItemSetInput = {
  id: number;
  name: string;
  effects: unknown;
  allowedClasses: string[] | null;
  classSource: 'items' | 'inferred' | 'manual' | null;
  buildId: string;
  itemIds: number[];
};

export async function upsertItemSet(db: Db, input: UpsertItemSetInput): Promise<void> {
  await db.query(
    `INSERT INTO forever_item_sets (id, name, effects, allowed_classes, class_source, build_id, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, now())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       effects = EXCLUDED.effects,
       allowed_classes = EXCLUDED.allowed_classes,
       class_source = EXCLUDED.class_source,
       build_id = EXCLUDED.build_id,
       updated_at = now()`,
    [
      input.id,
      input.name,
      JSON.stringify(input.effects ?? null),
      input.allowedClasses,
      input.classSource,
      input.buildId,
    ],
  );
  await db.query(`DELETE FROM forever_item_set_items WHERE set_id = $1`, [input.id]);
  if (input.itemIds.length > 0) {
    await db.query(
      `INSERT INTO forever_item_set_items (set_id, item_id)
       SELECT $1, UNNEST($2::int[])
       ON CONFLICT (set_id, item_id) DO NOTHING`,
      [input.id, input.itemIds],
    );
  }
}

export async function countItemSets(db: Db): Promise<number> {
  const res = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM forever_item_sets`);
  return Number(res.rows[0]?.n ?? 0);
}

export async function getItemSet(
  db: Db,
  setId: number,
): Promise<{ id: number; name: string; allowed_classes: string[] | null; class_source: string | null } | null> {
  const res = await db.query<{
    id: number;
    name: string;
    allowed_classes: string[] | null;
    class_source: string | null;
  }>(`SELECT id, name, allowed_classes, class_source FROM forever_item_sets WHERE id = $1`, [setId]);
  return res.rows[0] ?? null;
}

function escapeLikePattern(raw: string): string {
  // Escape \, %, and _ so user q is a literal substring under LIKE.
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function listItems(
  db: Db,
  filters: ListItemsFilters,
): Promise<{ items: ForeverItemRow[]; next_cursor: string | null }> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
  const params: unknown[] = [];
  const where: string[] = [];

  const effectiveClassesExpr =
    `COALESCE(NULLIF(i.allowed_classes, '{}'), s.allowed_classes)`;

  if (filters.excludeJunk !== false) {
    where.push(junkExclusionSql('i.name'));
  }
  if (filters.slot) {
    params.push(filters.slot);
    where.push(`(i.slot = $${params.length} OR $${params.length} = ANY(i.slot_aliases))`);
  }
  if (filters.armorType) {
    params.push(filters.armorType);
    where.push(`i.armor_type = $${params.length}`);
  }
  if (filters.q && filters.q.trim()) {
    params.push(`%${escapeLikePattern(filters.q.trim().toLowerCase())}%`);
    where.push(`lower(i.name) LIKE $${params.length} ESCAPE '\\'`);
  }
  if (filters.minItemLevel != null) {
    params.push(filters.minItemLevel);
    where.push(`i.item_level >= $${params.length}`);
  }
  if (filters.maxRequiredLevel != null) {
    params.push(filters.maxRequiredLevel);
    where.push(`i.required_level <= $${params.length}`);
  }
  if (filters.playableClass) {
    if (!isPlayableClass(filters.playableClass)) {
      throw new Error('bad_class');
    }
    const frag = classEquipSql(
      filters.playableClass as PlayableClass,
      filters.slot,
      params.length + 1,
      {
        armorType: 'i.armor_type',
        inventoryType: 'i.inventory_type',
        itemClass: 'i.item_class',
        itemSubclass: 'i.item_subclass',
        effectiveAllowedClasses: effectiveClassesExpr,
      },
    );
    where.push(frag.sql);
    params.push(...frag.params);
  }
  if (filters.cursor) {
    const after = decodeCursor(filters.cursor);
    if (after == null) throw new Error('bad_cursor');
    params.push(after);
    where.push(`i.item_id > $${params.length}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit + 1);
  const res = await db.query<ForeverItemRow>(
    `SELECT i.*,
            ${effectiveClassesExpr} AS effective_allowed_classes
     FROM forever_items i
     LEFT JOIN forever_item_sets s ON s.id = i.item_set_id
     ${whereSql}
     ORDER BY i.item_id ASC
     LIMIT $${params.length}`,
    params,
  );
  const rows = res.rows;
  let next_cursor: string | null = null;
  if (rows.length > limit) {
    const page = rows.slice(0, limit);
    const last = page[page.length - 1]!;
    next_cursor = encodeCursor(Number(last.item_id));
    return { items: page, next_cursor };
  }
  return { items: rows, next_cursor };
}

export function etagForItems(buildId: string, kind: string, body: unknown): string {
  const raw = `${buildId}:${kind}:${JSON.stringify(body)}`;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return `"${hash}"`;
}
