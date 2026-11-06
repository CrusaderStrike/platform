/**
 * Idempotent Forever item + item-set import from Blizzard static-forever-{region}.
 * Usage:
 *   DATABASE_URL=... npx tsx src/items/import.ts [--region us] [--delay-ms 120] [--only TYPE,TYPE]
 *   DATABASE_URL=... npx tsx src/items/import.ts --sets-only [--region us] [--delay-ms 120]
 * Never falls back to classic/retail namespaces.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { createBlizzardClient } from '../blizzard/client.js';
import { startMockBlizzard } from '../blizzard/mock.js';
import type { BlizzardRegion } from '../blizzard/regions.js';
import { isBlizzardRegion } from '../blizzard/regions.js';
import type { BlizzardItem } from '../blizzard/items.js';
import {
  IMPORT_EXCLUDED_ITEM_IDS,
  IMPORT_INVENTORY_TYPES,
  armorTypeFromClass,
  mapInventoryType,
  normalizeQuality,
} from './mapping.js';
import * as store from './store.js';
import type { ItemStat } from './store.js';
import { iconNameFromUrl, sanitizeBlizzardIconUrl } from '../lib/icon-url.js';
import { decideCatalogMetaActivation } from './import-meta-policy.js';
import {
  normalizePlayableClass,
  normalizePlayableClassList,
  type PlayableClass,
} from './playable-classes.js';
import { manualClassesForSet } from './set-classes.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv: string[]): {
  region: BlizzardRegion;
  delayMs: number;
  pageSize: number;
  only: Set<string> | null;
  setsOnly: boolean;
} {
  let region: BlizzardRegion = 'us';
  let delayMs = 120;
  let pageSize = 100;
  let only: Set<string> | null = null;
  let setsOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--region' && argv[i + 1]) {
      const r = argv[++i]!.toLowerCase();
      if (!isBlizzardRegion(r)) throw new Error(`Invalid --region ${r}`);
      region = r;
    } else if (a === '--delay-ms' && argv[i + 1]) {
      delayMs = Math.max(0, Number(argv[++i]));
    } else if (a === '--page-size' && argv[i + 1]) {
      pageSize = Math.min(1000, Math.max(1, Number(argv[++i])));
    } else if (a === '--only' && argv[i + 1]) {
      only = new Set(
        argv[++i]!.split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      );
    } else if (a === '--sets-only') {
      setsOnly = true;
    }
  }
  return { region, delayMs, pageSize, only, setsOnly };
}

function statsFromPreview(item: {
  preview_item?: { stats?: Array<{ type?: { type?: string }; value?: number }> };
}): ItemStat[] | null {
  const raw = item.preview_item?.stats;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: ItemStat[] = [];
  for (const s of raw) {
    const type = s.type?.type;
    const value = s.value;
    if (typeof type === 'string' && typeof value === 'number') {
      out.push({ type: type.toLowerCase(), value });
    }
  }
  return out.length ? out : null;
}

/** Extract lowercase class keys from preview_item.requirements.playable_classes. */
export function playableClassesFromItem(item: BlizzardItem): PlayableClass[] {
  const pcs = item.preview_item?.requirements?.playable_classes;
  if (!pcs) return [];
  const values: Array<string | number> = [];
  for (const link of pcs.links ?? []) {
    if (link.id != null) values.push(link.id);
    if (link.name) values.push(link.name);
  }
  if (pcs.display_string) values.push(pcs.display_string);
  return normalizePlayableClassList(values);
}

export function itemSetIdFromItem(item: BlizzardItem): number | null {
  const id = item.preview_item?.set?.item_set?.id;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
}

function isTransientBlizzardError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /blizzard_.*_5\d\d$/.test(msg) || /blizzard_.*_429$/.test(msg);
}

async function withRetries<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isTransientBlizzardError(err) || i === attempts) throw err;
      const backoff = Math.min(8000, 250 * 2 ** (i - 1));
      console.warn(
        `${label} transient error (attempt ${i}/${attempts}): ${err instanceof Error ? err.message : err}; retry in ${backoff}ms`,
      );
      await sleep(backoff);
    }
  }
  throw last;
}

type PieceClassIndex = Map<number, Set<PlayableClass>>;

async function importSets(args: {
  blizzard: ReturnType<typeof createBlizzardClient>;
  token: string;
  region: BlizzardRegion;
  delayMs: number;
  pool: ReturnType<typeof createPool>;
  buildId: string;
  /** Classes observed on items during the item pass (item_id → classes). */
  pieceClasses: PieceClassIndex;
}): Promise<{ setCount: number; unresolved: number[]; bySource: Record<string, number> }> {
  const { blizzard, token, region, delayMs, pool, buildId, pieceClasses } = args;
  const index = await withRetries('item-set-index', () => blizzard.fetchItemSetIndex(token, region));
  const sets = index.item_sets ?? [];
  const unresolved: number[] = [];
  const bySource = { items: 0, inferred: 0, manual: 0, none: 0 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const entry of sets) {
      const detail = await withRetries(`item-set:${entry.id}`, () =>
        blizzard.fetchItemSet(token, entry.id, region),
      );
      await sleep(delayMs);
      if (!detail) continue;
      const itemIds = (detail.items ?? [])
        .map((i) => i.id)
        .filter((id): id is number => typeof id === 'number');

      // Derive classes from piece restrictions observed on items (and any
      // already-stored forever_items.allowed_classes for those pieces).
      const derived = new Set<PlayableClass>();
      for (const itemId of itemIds) {
        const fromPass = pieceClasses.get(itemId);
        if (fromPass) for (const c of fromPass) derived.add(c);
      }
      // Also read DB for pieces that may have been imported earlier.
      if (derived.size === 0 && itemIds.length) {
        const res = await client.query<{ allowed_classes: string[] | null }>(
          `SELECT allowed_classes FROM forever_items
           WHERE item_id = ANY($1::bigint[]) AND allowed_classes IS NOT NULL`,
          [itemIds],
        );
        for (const row of res.rows) {
          for (const c of row.allowed_classes ?? []) {
            const n = normalizePlayableClass(c);
            if (n) derived.add(n);
          }
        }
      }

      let allowed: PlayableClass[] | null = null;
      let classSource: 'items' | 'inferred' | 'manual' | null = null;
      if (derived.size > 0) {
        allowed = [...derived].sort();
        classSource = 'items';
        bySource.items += 1;
      } else {
        const manual = manualClassesForSet(detail.id);
        if (manual) {
          allowed = manual;
          classSource = 'manual';
          bySource.manual += 1;
        } else {
          bySource.none += 1;
          unresolved.push(detail.id);
          console.warn(
            `set_unresolved id=${detail.id} name=${JSON.stringify(detail.name)} pieces=${itemIds.length}`,
          );
        }
      }

      await store.upsertItemSet(client, {
        id: detail.id,
        name: detail.name ?? entry.name ?? `Set ${detail.id}`,
        effects: detail.effects ?? null,
        allowedClasses: allowed,
        classSource,
        buildId,
        itemIds,
      });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { setCount: sets.length, unresolved, bySource };
}

async function main(): Promise<void> {
  const { region, delayMs, pageSize, only, setsOnly } = parseArgs(process.argv.slice(2));
  if (setsOnly && only) {
    throw new Error('--sets-only cannot be combined with --only');
  }
  const config = loadConfig();
  await migrate(config.DATABASE_URL);
  const pool = createPool(config.DATABASE_URL);

  let blizzard = createBlizzardClient({
    clientId: config.BLIZZARD_CLIENT_ID || 'unused',
    clientSecret: config.BLIZZARD_CLIENT_SECRET || 'unused',
    region: config.BLIZZARD_REGION,
    regions: config.BLIZZARD_REGIONS,
    authorizeUrl: config.oauthAuthorizeUrl,
    tokenUrl: config.oauthTokenUrl,
    apiBaseUrl: config.apiBaseUrl,
    redirectUri: config.BLIZZARD_REDIRECT_URI,
  });

  if (config.BLIZZARD_MOCK) {
    const mock = await startMockBlizzard();
    blizzard = createBlizzardClient({
      ...mock.config,
      regions: config.BLIZZARD_REGIONS,
      region: config.BLIZZARD_REGION,
      redirectUri: config.BLIZZARD_REDIRECT_URI,
    });
    console.log(`Using Blizzard mock at ${mock.baseUrl}`);
  }

  const token = await blizzard.fetchClientCredentialsToken();
  const pieceClasses: PieceClassIndex = new Map();

  let upserted = 0;
  let skippedUnmapped = 0;
  let itemErrors = 0;
  const perType: Record<string, number> = {};

  if (!setsOnly) {
    const walk = IMPORT_INVENTORY_TYPES.filter((inv) => {
      if (!only) return true;
      return only.has(inv);
    });
    if (only) {
      const unknown = [...only].filter((t) => !(IMPORT_INVENTORY_TYPES as readonly string[]).includes(t));
      if (unknown.length) {
        throw new Error(`Unknown --only inventory types: ${unknown.join(',')}`);
      }
      console.log(`--only ${walk.join(',')}`);
    }

    const seen = new Set<number>();
    for (const inv of walk) {
      let typeUpserts = 0;
      let page = 1;
      let pageCount = 1;
      while (page <= pageCount) {
        const search = await withRetries(`search:${inv}:p${page}`, () =>
          blizzard.searchItems(token, {
            inventoryType: inv,
            page,
            pageSize,
            region,
          }),
        );
        pageCount = Math.max(1, search.pageCount ?? 1);
        const results = search.results ?? [];
        for (const hit of results) {
          const id = hit.data?.id;
          if (!id || seen.has(id)) continue;
          if (IMPORT_EXCLUDED_ITEM_IDS.has(id)) continue;
          seen.add(id);
          try {
            const detail = await withRetries(`item:${id}`, () => blizzard.fetchItem(token, id, region));
            await sleep(delayMs);
            if (!detail) continue;
            const invType = detail.inventory_type?.type ?? hit.data?.inventory_type?.type ?? inv;
            const mapped = mapInventoryType(invType);
            if (!mapped) {
              skippedUnmapped += 1;
              continue;
            }
            const media = await withRetries(`media:${id}`, () =>
              blizzard.fetchItemIconUrl(token, id, region),
            );
            await sleep(delayMs);
            const iconUrl = sanitizeBlizzardIconUrl(media.iconUrl);
            const nameFromSearch =
              typeof hit.data?.name === 'object' && hit.data.name
                ? hit.data.name.en_US
                : typeof hit.data?.name === 'string'
                  ? hit.data.name
                  : undefined;
            const allowedClasses = playableClassesFromItem(detail);
            if (allowedClasses.length) {
              pieceClasses.set(id, new Set(allowedClasses));
            }
            const itemSetId = itemSetIdFromItem(detail);
            await store.upsertItem(pool, {
              itemId: id,
              name: detail.name ?? nameFromSearch ?? `Item ${id}`,
              slot: mapped.slot,
              slotAliases: mapped.aliases,
              inventoryType: invType,
              quality: normalizeQuality(detail.quality?.type ?? hit.data?.quality?.type),
              itemLevel: detail.level ?? hit.data?.level ?? 0,
              requiredLevel: detail.required_level ?? hit.data?.required_level ?? 0,
              armorType: armorTypeFromClass(
                detail.item_class?.id ?? hit.data?.item_class?.id ?? null,
                detail.item_subclass?.id ?? hit.data?.item_subclass?.id ?? null,
              ),
              itemClass: detail.item_class?.id ?? null,
              itemSubclass: detail.item_subclass?.id ?? null,
              allowedClasses: allowedClasses.length ? allowedClasses : null,
              itemSetId,
              stats: statsFromPreview(detail),
              iconUrl,
              iconName: media.iconName ?? iconNameFromUrl(iconUrl),
              region,
            });
            upserted += 1;
            typeUpserts += 1;
          } catch (err) {
            itemErrors += 1;
            console.warn(
              `item_error inventory_type=${inv} id=${id}: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
        page += 1;
        await sleep(delayMs);
      }
      perType[inv] = typeUpserts;
      console.log(
        `inventory_type=${inv} pages=${pageCount} upserted=${typeUpserts} upserted_so_far=${upserted}`,
      );
    }
  } else {
    console.log('--sets-only: skipping item pass');
  }

  const count = await store.countItems(pool);
  const buildId = setsOnly
    ? `forever-sets-${region}-${Date.now()}`
    : `forever-${region}-${count}-${Date.now()}`;

  const setResult = await importSets({
    blizzard,
    token,
    region,
    delayMs,
    pool,
    buildId,
    pieceClasses,
  });
  const setCount = await store.countItemSets(pool);

  if (setsOnly) {
    // Refresh set_count on meta without rewriting item_count / build_id identity of the catalog.
    const meta = await store.getMeta(pool);
    await store.setMeta(pool, {
      buildId: meta.build_id === 'empty' ? buildId : meta.build_id,
      itemCount: meta.item_count || count,
      setCount,
      region: meta.region || region,
    });
    console.log(
      JSON.stringify({
        ok: true,
        sets_only: true,
        region,
        set_count: setCount,
        sets_fetched: setResult.setCount,
        sets_unresolved: setResult.unresolved,
        sets_by_source: setResult.bySource,
        build_id: buildId,
      }),
    );
    await pool.end();
    return;
  }

  const metaDecision = decideCatalogMetaActivation({
    partialOnly: only != null,
    itemErrors,
  });
  if (!metaDecision.setMeta) {
    console.error(metaDecision.message);
    console.error(
      JSON.stringify({
        ok: false,
        refused_set_meta: true,
        region,
        upserted,
        skippedUnmapped,
        item_errors: itemErrors,
        item_count: count,
        set_count: setCount,
        sets_unresolved: setResult.unresolved,
        sets_by_source: setResult.bySource,
        build_id: null,
        per_type: perType,
        reason: metaDecision.message,
      }),
    );
    await pool.end();
    process.exit(1);
  }

  await store.setMeta(pool, { buildId, itemCount: count, setCount, region });
  console.log(
    JSON.stringify({
      ok: true,
      region,
      upserted,
      skippedUnmapped,
      item_errors: itemErrors,
      item_count: count,
      set_count: setCount,
      sets_fetched: setResult.setCount,
      sets_unresolved: setResult.unresolved,
      sets_by_source: setResult.bySource,
      build_id: buildId,
      per_type: perType,
    }),
  );
  await pool.end();
}

const isDirect =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
