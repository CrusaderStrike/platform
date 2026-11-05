import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestApp, signIn, shutdownEmbeddedPg, type TestCtx } from './helpers/setup.js';
import * as foreverItems from '../src/items/store.js';

async function clearCooldown(ctx: TestCtx) {
  await ctx.app.clearGearWriteCooldowns?.();
}

async function selectMain(ctx: TestCtx, cookie: string, csrf: string) {
  const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/me/characters', headers: { cookie } });
  const body = list.json() as {
    characters: { id: string; level: number | null; displayed: boolean }[];
    selection: { displayed_character_ids: string[] } | null;
  };
  const chosen = body.characters[0]!;
  if (!chosen.displayed) {
    const sel = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/me/characters/${chosen.id}`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { displayed: true },
    });
    expect(sel.statusCode).toBe(200);
  }
  return chosen;
}

async function seedHelmet(ctx: TestCtx, itemId = 16846) {
  await foreverItems.upsertItem(ctx.pool, {
    itemId,
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
    stats: null,
    iconUrl: null,
    iconName: null,
    region: 'us',
  });
  await foreverItems.setMeta(ctx.pool, { buildId: 'named-1', itemCount: 1, region: 'us' });
}

describe('named gear sets (platform#40)', () => {
  let ctx: TestCtx;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  afterAll(async () => {
    await ctx.stop();
    await shutdownEmbeddedPg();
  });
  beforeEach(async () => {
    await ctx.pool.query(`
      TRUNCATE public_api_rate_limits, upload_rate_limits, gear_write_rate_limits, pvp_battlegrounds, pvp_world_events, dungeon_runs,
               gear_list_events, gear_list_items, gear_lists, guild_members, guilds,
               forever_items, forever_items_meta, item_icon_cache, character_gear, character_selections, characters, sessions, oauth_states, users CASCADE
    `);
    await ctx.pool.query(
      `INSERT INTO forever_items_meta (id, build_id, item_count) VALUES (1, 'empty', 0) ON CONFLICT (id) DO NOTHING`,
    );
  });

  it('creates a leveling set with slots and rejects bad until_level', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const chosen = await selectMain(ctx, cookie, csrf);
    await ctx.pool.query(`UPDATE characters SET level = 40 WHERE id = $1`, [chosen.id]);

    await clearCooldown(ctx);
    const bad = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${chosen.id}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'TooLow', type: 'leveling', until_level: 40 },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({
      errors: { until_level: 'until_level_not_above_current_level' },
    });

    await clearCooldown(ctx);
    const ok = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${chosen.id}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        name: 'Pre-BiS 50',
        type: 'leveling',
        until_level: 50,
        role_spec: 'fury',
        slots: { head: 16846, main_hand: 19019, off_hand: null },
      },
    });
    expect(ok.statusCode).toBe(201);
    const body = ok.json() as {
      type: string;
      until_level: number;
      role_spec: string;
      outgrown: boolean;
      slots: Record<string, number | null>;
      items: { slot: string; item_id: number }[];
      version: number;
      edited_at: string;
    };
    expect(body.type).toBe('leveling');
    expect(body.until_level).toBe(50);
    expect(body.role_spec).toBe('fury');
    expect(body.outgrown).toBe(false);
    expect(body.slots.head).toBe(16846);
    expect(body.slots.main_hand).toBe(19019);
    expect(body.slots.off_hand).toBeNull();
    expect(body.items).toHaveLength(2);
    expect(body.version).toBe(3); // created + 2 slot sets
    expect(ok.headers.etag).toBe('"v3"');
  });

  it('rejects role_spec over 32 chars and leveling create at level 60', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const chosen = await selectMain(ctx, cookie, csrf);
    await ctx.pool.query(`UPDATE characters SET level = 60 WHERE id = $1`, [chosen.id]);

    await clearCooldown(ctx);
    const longSpec = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${chosen.id}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        name: 'LongSpec',
        type: 'max_level',
        role_spec: 'x'.repeat(33),
      },
    });
    expect(longSpec.statusCode).toBe(400);
    expect(longSpec.json()).toMatchObject({ errors: { role_spec: expect.any(String) } });

    await clearCooldown(ctx);
    const atSixty = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${chosen.id}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'TooLate', type: 'leveling', until_level: 60 },
    });
    expect(atSixty.statusCode).toBe(400);
    expect(atSixty.json()).toMatchObject({
      errors: { type: 'leveling_set_at_max_level' },
    });
  });

  it('PUT slot optional If-Match, no-op, validation_error field details, CSRF', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const chosen = await selectMain(ctx, cookie, csrf);
    await seedHelmet(ctx);

    await clearCooldown(ctx);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${chosen.id}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'Armory', type: 'max_level' },
    });
    expect(created.statusCode).toBe(201);
    const list = created.json() as { id: string; version: number };

    // Missing CSRF → 403
    await clearCooldown(ctx);
    const noCsrf = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/gear-lists/${list.id}/slots/head`,
      headers: { cookie },
      payload: { item_id: 16846 },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toMatchObject({ error: { code: 'csrf_failed' } });

    // No If-Match → last-write-wins
    await clearCooldown(ctx);
    const put = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/gear-lists/${list.id}/slots/head`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { item_id: 16846 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.headers.etag).toBe('"v2"');
    expect(put.json()).toMatchObject({ slot: 'head', item_id: 16846, version: 2 });

    // No-op same item_id → 200, same version
    await clearCooldown(ctx);
    const noop = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/gear-lists/${list.id}/slots/head`,
      headers: { cookie, 'x-csrf-token': csrf, 'if-match': '"v2"' },
      payload: { item_id: 16846 },
    });
    expect(noop.statusCode).toBe(200);
    expect(noop.headers.etag).toBe('"v2"');
    expect(noop.json()).toMatchObject({ slot: 'head', item_id: 16846, version: 2 });

    // Clear with If-Match
    await clearCooldown(ctx);
    const clear = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/gear-lists/${list.id}/slots/head`,
      headers: { cookie, 'x-csrf-token': csrf, 'if-match': '"v2"' },
      payload: { item_id: null },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json()).toMatchObject({ slot: 'head', item_id: null, version: 3 });

    // No-op clear
    await clearCooldown(ctx);
    const noopClear = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/gear-lists/${list.id}/slots/head`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { item_id: null },
    });
    expect(noopClear.statusCode).toBe(200);
    expect(noopClear.json()).toMatchObject({ slot: 'head', item_id: null, version: 3 });

    // invalid_slot as validation_error field detail
    const badSlot = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/gear-lists/${list.id}/slots/hat`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { item_id: 16846 },
    });
    expect(badSlot.statusCode).toBe(400);
    expect(badSlot.json()).toMatchObject({ errors: { slot: 'invalid_slot' } });

    // item_not_in_slot
    await clearCooldown(ctx);
    const wrongSlot = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/gear-lists/${list.id}/slots/main_hand`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { item_id: 16846 },
    });
    expect(wrongSlot.statusCode).toBe(400);
    expect(wrongSlot.json()).toMatchObject({ errors: { item_id: 'item_not_in_slot' } });

    // item_not_forever
    await clearCooldown(ctx);
    const missing = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/gear-lists/${list.id}/slots/head`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { item_id: 999999 },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ errors: { item_id: 'item_not_forever' } });

    // create slots map: invalid_slot + item_not_forever
    await clearCooldown(ctx);
    const createBadSlot = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${chosen.id}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'BadSlot', type: 'max_level', slots: { hat: 16846 } },
    });
    expect(createBadSlot.statusCode).toBe(400);
    expect(createBadSlot.json()).toMatchObject({ errors: { slot: 'invalid_slot' } });

    await clearCooldown(ctx);
    const createMissing = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${chosen.id}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'MissingItem', type: 'max_level', slots: { head: 999999 } },
    });
    expect(createMissing.statusCode).toBe(400);
    expect(createMissing.json()).toMatchObject({ errors: { item_id: 'item_not_forever' } });

    // Non-displayed character → 409 on create
    const chars = await ctx.app.inject({ method: 'GET', url: '/api/v1/me/characters', headers: { cookie } });
    const other = (chars.json() as { characters: { id: string; displayed: boolean }[] }).characters.find(
      (c) => c.id !== chosen.id && !c.displayed,
    );
    if (other) {
      await clearCooldown(ctx);
      const hidden = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/characters/${other.id}/gear-lists`,
        headers: { cookie, 'x-csrf-token': csrf },
        payload: { name: 'Hidden', type: 'max_level' },
      });
      expect(hidden.statusCode).toBe(409);
      expect(hidden.json()).toMatchObject({ error: { code: 'character_not_displayed' } });
    }

    // Unknown character → 404 (ownership before display gate)
    await clearCooldown(ctx);
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/ch_us_not_yours/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'Nope', type: 'max_level' },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('computes outgrown after level-up without deleting the set', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const chosen = await selectMain(ctx, cookie, csrf);
    await ctx.pool.query(`UPDATE characters SET level = 45 WHERE id = $1`, [chosen.id]);
    await clearCooldown(ctx);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${chosen.id}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'Leveling', type: 'leveling', until_level: 50 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ outgrown: false, until_level: 50 });
    const list = created.json() as { id: string };

    await ctx.pool.query(`UPDATE characters SET level = 55 WHERE id = $1`, [chosen.id]);
    const get = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/gear-lists/${list.id}`,
      headers: { cookie },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ outgrown: true, type: 'leveling', until_level: 50 });
  });
});
