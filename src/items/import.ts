/**
 * Idempotent Forever item import from Blizzard static-forever-{region}.
 * Usage: DATABASE_URL=... npx tsx src/items/import.ts [--region us] [--delay-ms 120]
 * Never falls back to classic/retail namespaces.
 */
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { createBlizzardClient } from '../blizzard/client.js';
import { startMockBlizzard } from '../blizzard/mock.js';
import type { BlizzardRegion } from '../blizzard/regions.js';
import { isBlizzardRegion } from '../blizzard/regions.js';
import {
  IMPORT_INVENTORY_TYPES,
  armorTypeFromClass,
  mapInventoryType,
  normalizeQuality,
} from './mapping.js';
import * as store from './store.js';
import type { ItemStat } from './store.js';
import { iconNameFromUrl, sanitizeBlizzardIconUrl } from '../lib/icon-url.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv: string[]): { region: BlizzardRegion; delayMs: number; pageSize: number } {
  let region: BlizzardRegion = 'us';
  let delayMs = 120;
  let pageSize = 100;
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
    }
  }
  return { region, delayMs, pageSize };
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

async function main(): Promise<void> {
  const { region, delayMs, pageSize } = parseArgs(process.argv.slice(2));
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
  const seen = new Set<number>();
  let upserted = 0;
  let skippedUnmapped = 0;

  for (const inv of IMPORT_INVENTORY_TYPES) {
    let page = 1;
    let pageCount = 1;
    while (page <= pageCount) {
      const search = await blizzard.searchItems(token, {
        inventoryType: inv,
        page,
        pageSize,
        region,
      });
      pageCount = Math.max(1, search.pageCount ?? 1);
      const results = search.results ?? [];
      for (const hit of results) {
        const id = hit.data?.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const detail = await blizzard.fetchItem(token, id, region);
        await sleep(delayMs);
        if (!detail) continue;
        const invType = detail.inventory_type?.type ?? hit.data?.inventory_type?.type ?? inv;
        const mapped = mapInventoryType(invType);
        if (!mapped) {
          skippedUnmapped += 1;
          continue;
        }
        const media = await blizzard.fetchItemIconUrl(token, id, region);
        await sleep(delayMs);
        const iconUrl = sanitizeBlizzardIconUrl(media.iconUrl);
        const nameFromSearch =
          typeof hit.data?.name === 'object' && hit.data.name
            ? hit.data.name.en_US
            : typeof hit.data?.name === 'string'
              ? hit.data.name
              : undefined;
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
          stats: statsFromPreview(detail),
          iconUrl,
          iconName: media.iconName ?? iconNameFromUrl(iconUrl),
          region,
        });
        upserted += 1;
      }
      page += 1;
      await sleep(delayMs);
    }
    console.log(`inventory_type=${inv} pages=${pageCount} upserted_so_far=${upserted}`);
  }

  const count = await store.countItems(pool);
  const buildId = `forever-${region}-${count}-${Date.now()}`;
  await store.setMeta(pool, { buildId, itemCount: count, region });
  console.log(
    JSON.stringify({
      ok: true,
      region,
      upserted,
      skippedUnmapped,
      item_count: count,
      build_id: buildId,
    }),
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
