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
    expect(mapInventoryType('TWOHWEAPON')?.slot).toBe('main_hand');
    expect(mapInventoryType('2HWEAPON')?.slot).toBe('main_hand');
    expect(mapInventoryType('RELIC')?.slot).toBe('ranged');
    expect(mapInventoryType('AMMO')?.slot).toBe('ammo');
    expect(mapInventoryType('THROWN')?.slot).toBe('ranged');
    expect(mapInventoryType('TABARD')?.slot).toBe('tabard');
    expect(mapInventoryType('TRINKET')).toEqual({ slot: 'trinket1', aliases: ['trinket2'] });
    expect(armorTypeFromClass(4, 3)).toBe('mail');
    expect(armorTypeFromClass(2, 7)).toBeNull();
  });

  it('IMPORT_INVENTORY_TYPES includes Forever TWOHWEAPON, RELIC, AMMO (not empty 2HWEAPON)', async () => {
    const { IMPORT_INVENTORY_TYPES, IMPORT_EXCLUDED_ITEM_IDS } = await import('../src/items/mapping.js');
    expect(IMPORT_INVENTORY_TYPES).toContain('TWOHWEAPON');
    expect(IMPORT_INVENTORY_TYPES).toContain('RELIC');
    expect(IMPORT_INVENTORY_TYPES).toContain('AMMO');
    expect(IMPORT_INVENTORY_TYPES).not.toContain('2HWEAPON');
    expect(IMPORT_EXCLUDED_ITEM_IDS.has(19082)).toBe(true); // Monster - Fire Arrow
    expect(IMPORT_EXCLUDED_ITEM_IDS.has(19286)).toBe(true); // Fast Test Ammo
  });

  it('GEAR_SLOTS includes ammo as a 20th slot', async () => {
    const { GEAR_SLOTS } = await import('../src/gear/schema.js');
    expect(GEAR_SLOTS).toContain('ammo');
    expect(GEAR_SLOTS).toHaveLength(20);
  });

  it('GET /api/v1/items?slot=ranged returns no AMMO items (ammo is its own slot)', async () => {
    await items.upsertItem(ctx.pool, {
      itemId: 22316,
      name: 'Shadow Relic',
      slot: 'ranged',
      slotAliases: [],
      inventoryType: 'RELIC',
      quality: 'common',
      itemLevel: 1,
      requiredLevel: 0,
      armorType: null,
      itemClass: 4,
      itemSubclass: 7,
      stats: null,
      iconUrl: 'https://render.worldofwarcraft.com/forever-us/icons/56/inv_relic.jpg',
      iconName: 'inv_relic',
      region: 'us',
    });
    await items.upsertItem(ctx.pool, {
      itemId: 2512,
      name: 'Rough Arrow',
      slot: 'ammo',
      slotAliases: [],
      inventoryType: 'AMMO',
      quality: 'common',
      itemLevel: 1,
      requiredLevel: 0,
      armorType: null,
      itemClass: 6,
      itemSubclass: 2,
      stats: null,
      iconUrl: 'https://render.worldofwarcraft.com/forever-us/icons/56/inv_ammo_arrow_01.jpg',
      iconName: 'inv_ammo_arrow_01',
      region: 'us',
    });
    await items.setMeta(ctx.pool, { buildId: 'ammo-slot-test', itemCount: 2, region: 'us' });

    const ranged = await ctx.app.inject({ method: 'GET', url: '/api/v1/items?slot=ranged' });
    expect(ranged.statusCode).toBe(200);
    const rangedBody = ranged.json() as { items: Array<{ item_id: number; slot: string; inventory_type: string }> };
    expect(rangedBody.items.every((i) => i.inventory_type !== 'AMMO')).toBe(true);
    expect(rangedBody.items.every((i) => i.slot !== 'ammo')).toBe(true);
    expect(rangedBody.items.map((i) => i.item_id)).toContain(22316);
    expect(rangedBody.items.map((i) => i.item_id)).not.toContain(2512);

    const ammo = await ctx.app.inject({ method: 'GET', url: '/api/v1/items?slot=ammo' });
    expect(ammo.statusCode).toBe(200);
    const ammoBody = ammo.json() as { items: Array<{ item_id: number; slot: string; inventory_type: string }> };
    expect(ammoBody.items).toHaveLength(1);
    expect(ammoBody.items[0]).toMatchObject({ item_id: 2512, slot: 'ammo', inventory_type: 'AMMO' });
  });

  it('decideCatalogMetaActivation refuses setMeta on --only or item_errors > 0', async () => {
    const { decideCatalogMetaActivation } = await import('../src/items/import-meta-policy.js');
    expect(decideCatalogMetaActivation({ partialOnly: false, itemErrors: 0 })).toEqual({ setMeta: true });
    const only = decideCatalogMetaActivation({ partialOnly: true, itemErrors: 0 });
    expect(only.setMeta).toBe(false);
    if (!only.setMeta) expect(only.message).toMatch(/--only/i);
    const errs = decideCatalogMetaActivation({ partialOnly: false, itemErrors: 3 });
    expect(errs.setMeta).toBe(false);
    if (!errs.setMeta) expect(errs.message).toMatch(/item_errors=3/);
    // --only wins even when errors are also present
    const both = decideCatalogMetaActivation({ partialOnly: true, itemErrors: 9 });
    expect(both.setMeta).toBe(false);
  });

  it('GET /api/v1/items filters by slot, armor_type, q and returns snake_case Forever fields', async () => {
    await seedCatalog();
    const head = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/items?slot=head&armor_type=mail',
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
      url: '/api/v1/items/search?slot=head&armor_type=cloth',
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

  it('rejects bad slot / armor_type / class query params', async () => {
    const badSlot = await ctx.app.inject({ method: 'GET', url: '/api/v1/items?slot=hat' });
    expect(badSlot.statusCode).toBe(400);
    const badArmor = await ctx.app.inject({ method: 'GET', url: '/api/v1/items?armor_type=clothh' });
    expect(badArmor.statusCode).toBe(400);
    const badClass = await ctx.app.inject({ method: 'GET', url: '/api/v1/items?class=cloth' });
    expect(badClass.statusCode).toBe(400); // cloth is armor_type, not a playable class
    const badClass2 = await ctx.app.inject({ method: 'GET', url: '/api/v1/items?class=hunterx' });
    expect(badClass2.statusCode).toBe(400);
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

  it('returns invalid_slot field detail for a bad slot', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/items?slot=hat' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errors: { slot: 'invalid_slot' },
    });
  });

  it('treats LIKE metacharacters in q as literals', async () => {
    await items.upsertItem(ctx.pool, {
      itemId: 90001,
      name: '100% Crit Ring_of_Binding',
      slot: 'finger1',
      slotAliases: ['finger2'],
      inventoryType: 'FINGER',
      quality: 'epic',
      itemLevel: 70,
      requiredLevel: 60,
      armorType: null,
      itemClass: 4,
      itemSubclass: 0,
      stats: null,
      iconUrl: null,
      iconName: null,
      region: 'us',
    });
    await items.upsertItem(ctx.pool, {
      itemId: 90002,
      name: 'Plain Crit Ring',
      slot: 'finger1',
      slotAliases: ['finger2'],
      inventoryType: 'FINGER',
      quality: 'rare',
      itemLevel: 60,
      requiredLevel: 50,
      armorType: null,
      itemClass: 4,
      itemSubclass: 0,
      stats: null,
      iconUrl: null,
      iconName: null,
      region: 'us',
    });
    await items.setMeta(ctx.pool, { buildId: 'like-escape', itemCount: 2, region: 'us' });
    const pct = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/items?q=' + encodeURIComponent('100% Crit'),
    });
    expect(pct.statusCode).toBe(200);
    const pctIds = (pct.json() as { items: { item_id: number }[] }).items.map((i) => i.item_id);
    expect(pctIds).toContain(90001);
    expect(pctIds).not.toContain(90002);

    const under = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/items?q=' + encodeURIComponent('Ring_of'),
    });
    expect(under.statusCode).toBe(200);
    const underIds = (under.json() as { items: { item_id: number }[] }).items.map((i) => i.item_id);
    expect(underIds).toEqual([90001]);
  });

  it('returns 429 when the public items bucket is exhausted', async () => {
    const { hashIp } = await import('../src/guilds/rate-limit.js');
    await ctx.pool.query(`DELETE FROM public_api_rate_limits WHERE bucket = 'items'`);
    await ctx.pool.query(
      `INSERT INTO public_api_rate_limits (ip_hash, bucket, window_start, hit_count)
       VALUES ($1, 'items', now(), 240)`,
      [hashIp('127.0.0.1')],
    );
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/items' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeTruthy();
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.json().error.code).toBe('rate_limited');
    expect(res.headers['ratelimit-remaining']).toBe('0');

    const detail = await ctx.app.inject({ method: 'GET', url: '/api/v1/items/19019' });
    expect(detail.statusCode).toBe(429);

    const search = await ctx.app.inject({ method: 'GET', url: '/api/v1/items/search' });
    expect(search.statusCode).toBe(429);
  });

  describe('Equip rules class filter (platform#78)', () => {
    async function seedEquipCatalog(): Promise<void> {
      await ctx.pool.query(`DELETE FROM public_api_rate_limits WHERE bucket = 'items'`);
      const rows: Array<Parameters<typeof items.upsertItem>[1]> = [
        {
          itemId: 21355,
          name: 'Genesis Boots',
          slot: 'feet',
          slotAliases: [],
          inventoryType: 'FEET',
          quality: 'epic',
          itemLevel: 78,
          requiredLevel: 60,
          armorType: 'leather',
          itemClass: 4,
          itemSubclass: 2,
          allowedClasses: ['druid'],
          itemSetId: 493,
          stats: null,
          iconUrl: null,
          iconName: null,
          region: 'us',
        },
        {
          itemId: 22490,
          name: 'Dreamwalker Headpiece',
          slot: 'head',
          slotAliases: [],
          inventoryType: 'HEAD',
          quality: 'epic',
          itemLevel: 88,
          requiredLevel: 60,
          armorType: 'leather',
          itemClass: 4,
          itemSubclass: 2,
          allowedClasses: null,
          itemSetId: 521,
          stats: null,
          iconUrl: null,
          iconName: null,
          region: 'us',
        },
        {
          itemId: 22418,
          name: 'Dreadnaught Helmet',
          slot: 'head',
          slotAliases: [],
          inventoryType: 'HEAD',
          quality: 'epic',
          itemLevel: 88,
          requiredLevel: 60,
          armorType: 'plate',
          itemClass: 4,
          itemSubclass: 4,
          allowedClasses: null,
          itemSetId: 523,
          stats: null,
          iconUrl: null,
          iconName: null,
          region: 'us',
        },
        {
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
          allowedClasses: null,
          itemSetId: null,
          stats: null,
          iconUrl: null,
          iconName: null,
          region: 'us',
        },
        {
          itemId: 1935,
          name: "Assassin's Blade",
          slot: 'main_hand',
          slotAliases: ['off_hand'],
          inventoryType: 'WEAPON',
          quality: 'rare',
          itemLevel: 24,
          requiredLevel: 19,
          armorType: null,
          itemClass: 2,
          itemSubclass: 15,
          allowedClasses: null,
          itemSetId: null,
          stats: null,
          iconUrl: null,
          iconName: null,
          region: 'us',
        },
        {
          itemId: 19348,
          name: 'Red Dragonscale Protector',
          slot: 'off_hand',
          slotAliases: [],
          inventoryType: 'SHIELD',
          quality: 'epic',
          itemLevel: 74,
          requiredLevel: 60,
          armorType: null,
          itemClass: 4,
          itemSubclass: 6,
          allowedClasses: null,
          itemSetId: null,
          stats: null,
          iconUrl: null,
          iconName: null,
          region: 'us',
        },
        {
          itemId: 19366,
          name: "Master Dragonslayer's Orb",
          slot: 'off_hand',
          slotAliases: [],
          inventoryType: 'HOLDABLE',
          quality: 'epic',
          itemLevel: 83,
          requiredLevel: 60,
          armorType: null,
          itemClass: 4,
          itemSubclass: 0,
          allowedClasses: null,
          itemSetId: null,
          stats: null,
          iconUrl: null,
          iconName: null,
          region: 'us',
        },
        {
          itemId: 22397,
          name: 'Idol of Ferocity',
          slot: 'ranged',
          slotAliases: [],
          inventoryType: 'RELIC',
          quality: 'rare',
          itemLevel: 62,
          requiredLevel: 57,
          armorType: null,
          itemClass: 4,
          itemSubclass: 8,
          allowedClasses: null,
          itemSetId: null,
          stats: null,
          iconUrl: null,
          iconName: null,
          region: 'us',
        },
        {
          itemId: 22399,
          name: 'Libram of Truth',
          slot: 'ranged',
          slotAliases: [],
          inventoryType: 'RELIC',
          quality: 'rare',
          itemLevel: 62,
          requiredLevel: 57,
          armorType: null,
          itemClass: 4,
          itemSubclass: 7,
          allowedClasses: null,
          itemSetId: null,
          stats: null,
          iconUrl: null,
          iconName: null,
          region: 'us',
        },
        {
          itemId: 2512,
          name: 'Rough Arrow',
          slot: 'ammo',
          slotAliases: [],
          inventoryType: 'AMMO',
          quality: 'common',
          itemLevel: 5,
          requiredLevel: 1,
          armorType: null,
          itemClass: 6,
          itemSubclass: 2,
          allowedClasses: null,
          itemSetId: null,
          stats: null,
          iconUrl: null,
          iconName: null,
          region: 'us',
        },
        {
          itemId: 99901,
          name: '[PH] Deprecated Cloth Helm',
          slot: 'head',
          slotAliases: [],
          inventoryType: 'HEAD',
          quality: 'poor',
          itemLevel: 1,
          requiredLevel: 0,
          armorType: 'cloth',
          itemClass: 4,
          itemSubclass: 1,
          allowedClasses: null,
          itemSetId: null,
          stats: null,
          iconUrl: null,
          iconName: null,
          region: 'us',
        },
        {
          itemId: 13348,
          name: 'Demonshear Offhand',
          slot: 'off_hand',
          slotAliases: [],
          inventoryType: 'WEAPONOFFHAND',
          quality: 'rare',
          itemLevel: 63,
          requiredLevel: 58,
          armorType: null,
          itemClass: 2,
          itemSubclass: 13,
          allowedClasses: null,
          itemSetId: null,
          stats: null,
          iconUrl: null,
          iconName: null,
          region: 'us',
        },
        {
          itemId: 11263,
          name: 'Nether Force Wand',
          slot: 'ranged',
          slotAliases: [],
          inventoryType: 'RANGEDRIGHT',
          quality: 'rare',
          itemLevel: 40,
          requiredLevel: 35,
          armorType: null,
          itemClass: 2,
          itemSubclass: 19,
          allowedClasses: null,
          itemSetId: null,
          stats: null,
          iconUrl: null,
          iconName: null,
          region: 'us',
        },
      ];
      for (const row of rows) {
        await items.upsertItem(ctx.pool, row);
      }
      await items.upsertItemSet(ctx.pool, {
        id: 493,
        name: 'Genesis Raiment',
        effects: null,
        allowedClasses: ['druid'],
        classSource: 'items',
        buildId: 'test-sets',
        itemIds: [21355],
      });
      await items.upsertItemSet(ctx.pool, {
        id: 521,
        name: 'Dreamwalker Raiment',
        effects: null,
        allowedClasses: ['druid'],
        classSource: 'manual',
        buildId: 'test-sets',
        itemIds: [22490],
      });
      await items.upsertItemSet(ctx.pool, {
        id: 523,
        name: "Dreadnaught's Battlegear",
        effects: null,
        allowedClasses: ['warrior'],
        classSource: 'manual',
        buildId: 'test-sets',
        itemIds: [22418],
      });
      await items.setMeta(ctx.pool, {
        buildId: 'equip-rules-test',
        itemCount: rows.length,
        setCount: 3,
        region: 'us',
      });
    }

    it('class=druid returns leather armor, idols, held; hides plate sets, librams, junk', async () => {
      await seedEquipCatalog();
      const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/items?class=druid&limit=100' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        items: Array<{
          item_id: number;
          item_class: number | null;
          item_subclass: number | null;
          allowed_classes: string[] | null;
        }>;
      };
      const ids = body.items.map((i) => i.item_id);
      expect(ids).toContain(21355); // Genesis tagged druid
      expect(ids).toContain(22490); // Dreamwalker via manual set
      expect(ids).toContain(22397); // idol
      expect(ids).toContain(19366); // held
      expect(ids).toContain(13348); // WEAPONOFFHAND for all classes
      expect(ids).toContain(16914); // cloth ok for druid
      expect(ids).not.toContain(22418); // warrior T3
      expect(ids).not.toContain(22399); // libram
      expect(ids).not.toContain(2512); // ammo
      expect(ids).not.toContain(99901); // junk
      const genesis = body.items.find((i) => i.item_id === 21355)!;
      expect(genesis).toMatchObject({
        item_class: 4,
        item_subclass: 2,
        allowed_classes: ['druid'],
      });
      const dream = body.items.find((i) => i.item_id === 22490)!;
      expect(dream.allowed_classes).toEqual(['druid']);
    });

    it('class=warrior&slot=off_hand allows shield, dual-wield 1H, WEAPONOFFHAND; mage gets held+WEAPONOFFHAND only', async () => {
      await seedEquipCatalog();
      const war = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/items?class=warrior&slot=off_hand',
      });
      expect(war.statusCode).toBe(200);
      const warIds = (war.json() as { items: { item_id: number }[] }).items.map((i) => i.item_id);
      expect(warIds).toContain(19348); // shield
      expect(warIds).toContain(1935); // generic WEAPON dagger via aliases (dual-wield)
      expect(warIds).toContain(19366); // held
      expect(warIds).toContain(13348); // WEAPONOFFHAND fist

      const mage = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/items?class=mage&slot=off_hand',
      });
      expect(mage.statusCode).toBe(200);
      const mageIds = (mage.json() as { items: { item_id: number }[] }).items.map((i) => i.item_id);
      expect(mageIds).toContain(19366); // held — all classes
      expect(mageIds).toContain(13348); // WEAPONOFFHAND — all classes, even fist subclass mage lacks
      expect(mageIds).not.toContain(19348); // shield restricted
      expect(mageIds).not.toContain(1935); // generic WEAPON requires dual-wield

      const priest = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/items?class=priest&slot=off_hand',
      });
      expect(priest.statusCode).toBe(200);
      const priestIds = (priest.json() as { items: { item_id: number }[] }).items.map((i) => i.item_id);
      expect(priestIds).toContain(13348);
      expect(priestIds).toContain(19366);
      expect(priestIds).not.toContain(19348);
      expect(priestIds).not.toContain(1935);
    });

    it('class=hunter gets ammo; class=priest gets wands not guns/ammo', async () => {
      await seedEquipCatalog();
      const hunter = await ctx.app.inject({ method: 'GET', url: '/api/v1/items?class=hunter&slot=ammo' });
      expect(hunter.statusCode).toBe(200);
      expect((hunter.json() as { items: { item_id: number }[] }).items.map((i) => i.item_id)).toEqual([
        2512,
      ]);

      const priest = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/items?class=priest&slot=ranged',
      });
      expect(priest.statusCode).toBe(200);
      const ids = (priest.json() as { items: { item_id: number }[] }).items.map((i) => i.item_id);
      expect(ids).toContain(11263);
      expect(ids).not.toContain(22397);
    });

    it('class and armor_type combine; junk excluded by default without class', async () => {
      await seedEquipCatalog();
      const both = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/items?class=druid&armor_type=leather',
      });
      expect(both.statusCode).toBe(200);
      const ids = (both.json() as { items: { item_id: number }[] }).items.map((i) => i.item_id);
      expect(ids).toContain(21355);
      expect(ids).toContain(22490);
      expect(ids).not.toContain(16914);

      const all = await ctx.app.inject({ method: 'GET', url: '/api/v1/items?slot=head&limit=100' });
      expect(all.statusCode).toBe(200);
      const headIds = (all.json() as { items: { item_id: number }[] }).items.map((i) => i.item_id);
      expect(headIds).not.toContain(99901);
    });

    it('import --sets-only against the mock upserts sets with items/manual sources', async () => {
      const { startMockBlizzard } = await import('../src/blizzard/mock.js');
      const mock = await startMockBlizzard();
      try {
        // Seed Dreamwalker + Genesis items so set import can see piece tags / set ids
        await items.upsertItem(ctx.pool, {
          itemId: 21355,
          name: 'Genesis Boots',
          slot: 'feet',
          slotAliases: [],
          inventoryType: 'FEET',
          quality: 'epic',
          itemLevel: 78,
          requiredLevel: 60,
          armorType: 'leather',
          itemClass: 4,
          itemSubclass: 2,
          allowedClasses: ['druid'],
          itemSetId: 493,
          stats: null,
          iconUrl: null,
          iconName: null,
          region: 'us',
        });
        await items.upsertItem(ctx.pool, {
          itemId: 22490,
          name: 'Dreamwalker Headpiece',
          slot: 'head',
          slotAliases: [],
          inventoryType: 'HEAD',
          quality: 'epic',
          itemLevel: 88,
          requiredLevel: 60,
          armorType: 'leather',
          itemClass: 4,
          itemSubclass: 2,
          allowedClasses: null,
          itemSetId: 521,
          stats: null,
          iconUrl: null,
          iconName: null,
          region: 'us',
        });
        await items.setMeta(ctx.pool, { buildId: 'pre-sets', itemCount: 2, region: 'us' });

        const client = createBlizzardClient({
          ...mock.config,
          region: 'us',
          regions: ['us'],
          redirectUri: ctx.config.BLIZZARD_REDIRECT_URI,
        });
        const token = await client.fetchClientCredentialsToken();
        const index = await client.fetchItemSetIndex(token, 'us');
        expect((index.item_sets ?? []).map((s) => s.id).sort()).toEqual([493, 521, 523]);

        // Drive the same upsert path the CLI uses
        const { manualClassesForSet } = await import('../src/items/set-classes.js');
        for (const entry of index.item_sets ?? []) {
          const detail = await client.fetchItemSet(token, entry.id, 'us');
          expect(detail).toBeTruthy();
          const itemIds = (detail!.items ?? []).map((i) => i.id!).filter(Boolean);
          let allowed: string[] | null = null;
          let classSource: 'items' | 'manual' | null = null;
          const dbClasses = await ctx.pool.query<{ allowed_classes: string[] | null }>(
            `SELECT allowed_classes FROM forever_items WHERE item_id = ANY($1::bigint[]) AND allowed_classes IS NOT NULL`,
            [itemIds],
          );
          const derived = new Set<string>();
          for (const row of dbClasses.rows) {
            for (const c of row.allowed_classes ?? []) derived.add(c);
          }
          if (derived.size) {
            allowed = [...derived].sort();
            classSource = 'items';
          } else {
            const manual = manualClassesForSet(entry.id);
            if (manual) {
              allowed = [...manual];
              classSource = 'manual';
            }
          }
          await items.upsertItemSet(ctx.pool, {
            id: entry.id,
            name: detail!.name ?? entry.name ?? `Set ${entry.id}`,
            effects: detail!.effects ?? null,
            allowedClasses: allowed,
            classSource,
            buildId: 'sets-only-test',
            itemIds,
          });
        }
        const genesis = await items.getItemSet(ctx.pool, 493);
        expect(genesis).toMatchObject({ allowed_classes: ['druid'], class_source: 'items' });
        const dream = await items.getItemSet(ctx.pool, 521);
        expect(dream).toMatchObject({ allowed_classes: ['druid'], class_source: 'manual' });
        const dread = await items.getItemSet(ctx.pool, 523);
        expect(dread).toMatchObject({ allowed_classes: ['warrior'], class_source: 'manual' });
        expect(await items.countItemSets(ctx.pool)).toBe(3);
      } finally {
        await mock.close();
      }
    });
  });
  });
  
