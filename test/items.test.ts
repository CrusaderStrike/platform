import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, shutdownEmbeddedPg, type TestCtx } from './helpers/setup.js';
import * as items from '../src/items/store.js';
import { mapInventoryType, armorTypeFromClass } from '../src/items/mapping.js';
import { createBlizzardClient } from '../src/blizzard/client.js';

describe('Forever items catalog', () => {
  let ctx: TestCtx;

  beforeAll(async () => {
    ctx = await startTestApp();
  }, 120_000);

  afterAll(async () => {
    await ctx.stop();
    await shutdownEmbeddedPg();
  });

  async function seedCatalog(): Promise<void> {
    await items.upsertItem(ctx.pool, {
      itemId: 19019,
      name: 'Thunderfury, Blessed Blade of the Windseeker',
      slot: 'main_hand',
      slotAliases: ['off_hand'],
      inventoryType: 'WEAPON',
      quality: 'legendary',
      itemLevel: 80,
      requiredLevel: 60,
      armorType: null,
      itemClass: 2,
      itemSubclass: 7,
      stats: [
        { type: 'agility', value: 44 },
        { type: 'stamina', value: 22 },
      ],
      iconUrl: 'https://render.worldofwarcraft.com/forever-us/icons/56/inv_sword_39.jpg',
      iconName: 'inv_sword_39',
      region: 'us',
    });
    await items.upsertItem(ctx.pool, {
      itemId: 16846,
      name: "Giantstalker's Helmet",
      slot: 'head',
      slotAliases: [],
      inventoryType: 'HEAD',
      quality: 'epic',
      itemLevel: 66,
      requiredLevel: 60,
      armorType: 'mail',
      itemClass: 4,
      itemSubclass: 3,
      stats: [{ type: 'agility', value: 23 }],
      iconUrl: 'https://render.worldofwarcraft.com/forever-us/icons/56/inv_helmet_05.jpg',
      iconName: 'inv_helmet_05',
      region: 'us',
    });
    await items.upsertItem(ctx.pool, {
      itemId: 16914,
      name: 'Netherwind Crown',
      slot: 'head',
      slotAliases: [],
      inventoryType: 'HEAD',
      quality: 'epic',
      itemLevel: 76,
      requiredLevel: 60,
      armorType: 'cloth',
      itemClass: 4,
      itemSubclass: 1,
      stats: [{ type: 'intellect', value: 30 }],
      iconUrl: 'https://render.worldofwarcraft.com/forever-us/icons/56/inv_crown_01.jpg',
      iconName: 'inv_crown_01',
      region: 'us',
    });
    await items.upsertItem(ctx.pool, {
      itemId: 18813,
      name: 'Ring of Binding',
      slot: 'finger1',
      slotAliases: ['finger2'],
      inventoryType: 'FINGER',
      quality: 'epic',
      itemLevel: 73,
      requiredLevel: 60,
      armorType: null,
      itemClass: 4,
      itemSubclass: 0,
      stats: null,
      iconUrl: 'https://render.worldofwarcraft.com/forever-us/icons/56/inv_jewelry_ring_13.jpg',
      iconName: 'inv_jewelry_ring_13',
      region: 'us',
    });
    await items.setMeta(ctx.pool, {
      buildId: 'test-forever-us-4',
      itemCount: 4,
      region: 'us',
    });
  }

  it('maps inventory types to GearSlots including aliases', () => {
    expect(mapInventoryType('HEAD')?.slot).toBe('head');
    expect(mapInventoryType('FINGER')).toEqual({ slot: 'finger1', aliases: ['finger2'] });
    expect(mapInventoryType('WEAPON')).toEqual({ slot: 'main_hand', aliases: ['off_hand'] });
    expect(mapInventoryType('CLOAK')?.slot).toBe('back');
    expect(armorTypeFromClass(4, 3)).toBe('mail');
    expect(armorTypeFromClass(2, 7)).toBeNull();
  });

  it('GET /api/v1/items filters by slot, class, q and returns snake_case Forever fields', async () => {
    await seedCatalog();
    const head = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/items?slot=head&class=mail',
    });
    expect(head.statusCode).toBe(200);
    expect(head.headers.etag).toBeTruthy();
    expect(head.headers['cache-control']).toContain('max-age=300');
    const headBody = head.json() as {
      items: Array<Record<string, unknown>>;
      next_cursor: string | null;
    };
    expect(headBody.items).toHaveLength(1);
    expect(headBody.items[0]).toMatchObject({
      item_id: 16846,
      name: "Giantstalker's Helmet",
      slot: 'head',
      inventory_type: 'HEAD',
      quality: 'epic',
      item_level: 66,
      required_level: 60,
      armor_type: 'mail',
      source: 'blizzard_forever',
      verified: true,
    });
    expect(headBody.items[0]!.icon_url).toContain('render.worldofwarcraft.com');

    const q = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/items?q=Thunder',
    });
    expect(q.statusCode).toBe(200);
    const qBody = q.json() as { items: Array<{ item_id: number }> };
    expect(qBody.items.map((i) => i.item_id)).toEqual([19019]);

    const finger2 = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/items?slot=finger2',
    });
    expect(finger2.statusCode).toBe(200);
    const fBody = finger2.json() as { items: Array<{ item_id: number; slot: string }> };
    expect(fBody.items.map((i) => i.item_id)).toEqual([18813]);
    expect(fBody.items[0]!.slot).toBe('finger1');
  });

  it('GET /api/v1/items/{id} and 404 / search alias / 304', async () => {
    await seedCatalog();
    const ok = await ctx.app.inject({ method: 'GET', url: '/api/v1/items/19019' });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { item_id: number; source: string };
    expect(body.item_id).toBe(19019);
    expect(body.source).toBe('blizzard_forever');

    const missing = await ctx.app.inject({ method: 'GET', url: '/api/v1/items/999999' });
    expect(missing.statusCode).toBe(404);

    const alias = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/items/search?slot=head&class=cloth',
    });
    expect(alias.statusCode).toBe(200);
    const aBody = alias.json() as { items: Array<{ item_id: number }> };
    expect(aBody.items.map((i) => i.item_id)).toEqual([16914]);

    const etag = ok.headers.etag as string;
    const again = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/items/19019',
      headers: { 'if-none-match': etag },
    });
    expect(again.statusCode).toBe(304);
  });

  it('rejects bad slot / class query params', async () => {
    const badSlot = await ctx.app.inject({ method: 'GET', url: '/api/v1/items?slot=hat' });
    expect(badSlot.statusCode).toBe(400);
    const badClass = await ctx.app.inject({ method: 'GET', url: '/api/v1/items?class=clothh' });
    expect(badClass.statusCode).toBe(400);
  });

  it('Blizzard mock Forever static: client credentials, item, media, search; rejects classic', async () => {
    const client = createBlizzardClient({
      ...ctx.mock.config,
      region: 'us',
      regions: ['us'],
      redirectUri: ctx.config.BLIZZARD_REDIRECT_URI,
    });
    const token = await client.fetchClientCredentialsToken();
    expect(token).toBeTruthy();

    const item = await client.fetchItem(token, 19019, 'us');
    expect(item?.name).toContain('Thunderfury');

    const media = await client.fetchItemIconUrl(token, 19019, 'us');
    expect(media.iconUrl).toContain('forever-us');
    expect(media.iconUrl).toContain('render.worldofwarcraft.com');

    const search = await client.searchItems(token, { inventoryType: 'HEAD', region: 'us' });
    expect((search.results ?? []).length).toBeGreaterThan(0);

    // Classic namespace must not be used by the client; mock rejects if forced.
    const classicUrl = `${ctx.mock.apiBaseUrl}/data/wow/item/19019?namespace=static-classic-us&locale=en_US`;
    const classicRes = await fetch(classicUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    expect(classicRes.status).toBe(403);
  });

  it('import upsert is idempotent against the mock', async () => {
    // Minimal import of HEAD inventory type via client APIs used by the CLI.
    const client = createBlizzardClient({
      ...ctx.mock.config,
      region: 'us',
      regions: ['us'],
      redirectUri: ctx.config.BLIZZARD_REDIRECT_URI,
    });
    const token = await client.fetchClientCredentialsToken();
    const search = await client.searchItems(token, { inventoryType: 'HEAD', region: 'us' });
    for (const hit of search.results ?? []) {
      const id = hit.data?.id;
      if (!id) continue;
      const detail = await client.fetchItem(token, id, 'us');
      if (!detail) continue;
      const mapped = mapInventoryType(detail.inventory_type?.type ?? 'HEAD');
      if (!mapped) continue;
      const media = await client.fetchItemIconUrl(token, id, 'us');
      await items.upsertItem(ctx.pool, {
        itemId: id,
        name: detail.name ?? `Item ${id}`,
        slot: mapped.slot,
        slotAliases: mapped.aliases,
        inventoryType: detail.inventory_type?.type ?? 'HEAD',
        quality: (detail.quality?.type ?? 'common').toLowerCase(),
        itemLevel: detail.level ?? 0,
        requiredLevel: detail.required_level ?? 0,
        armorType: armorTypeFromClass(detail.item_class?.id ?? null, detail.item_subclass?.id ?? null),
        itemClass: detail.item_class?.id ?? null,
        itemSubclass: detail.item_subclass?.id ?? null,
        stats: null,
        iconUrl: media.iconUrl,
        iconName: media.iconName,
        region: 'us',
      });
    }
    const first = await items.countItems(ctx.pool);
    // Second upsert of same ids must not grow the table.
    for (const hit of search.results ?? []) {
      const id = hit.data?.id;
      if (!id) continue;
      const detail = await client.fetchItem(token, id, 'us');
      if (!detail) continue;
      const mapped = mapInventoryType(detail.inventory_type?.type ?? 'HEAD')!;
      await items.upsertItem(ctx.pool, {
        itemId: id,
        name: detail.name ?? `Item ${id}`,
        slot: mapped.slot,
        slotAliases: mapped.aliases,
        inventoryType: detail.inventory_type?.type ?? 'HEAD',
        quality: (detail.quality?.type ?? 'common').toLowerCase(),
        itemLevel: detail.level ?? 0,
        requiredLevel: detail.required_level ?? 0,
        armorType: armorTypeFromClass(detail.item_class?.id ?? null, detail.item_subclass?.id ?? null),
        itemClass: detail.item_class?.id ?? null,
        itemSubclass: detail.item_subclass?.id ?? null,
        stats: null,
        iconUrl: null,
        iconName: null,
        region: 'us',
      });
    }
    const second = await items.countItems(ctx.pool);
    expect(second).toBe(first);
    expect(first).toBeGreaterThanOrEqual(3);
  });
});
