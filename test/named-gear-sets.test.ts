import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestApp, signIn, shutdownEmbeddedPg, type TestCtx } from './helpers/setup.js';
import * as foreverItems from '../src/items/store.js';

async function clearCooldown(ctx: TestCtx) {
  await ctx.app.clearGearWriteCooldowns?.();
}

async function selectMain(ctx: TestCtx, cookie: string, csrf: string) {
  const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/me/characters', headers: { cookie } });
  const body = list.json() as { characters: { id: string; level: number | null }[]; selection: { main_id: string } | null };
  const chosen = body.characters[0]!;
  if (!body.selection || body.selection.main_id !== chosen.id) {
    const sel = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/me/characters/selection',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { main_id: chosen.id, alt_ids: [] },
    });
    expect(sel.statusCode).toBe(200);
  }
  return chosen;
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
    // Fixture characters are typically under 60; force a known level for the rule.
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

  it('PUT slot with If-Match sets and clears; rejects non-displayed character', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const chosen = await selectMain(ctx, cookie, csrf);
    await foreverItems.upsertItem(ctx.pool, {
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
      stats: null,
      iconUrl: null,
      iconName: null,
      region: 'us',
    });
    await foreverItems.setMeta(ctx.pool, { buildId: 'named-1', itemCount: 1, region: 'us' });

    await clearCooldown(ctx);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${chosen.id}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'Armory', type: 'max_level' },
    });
    expect(created.statusCode).toBe(201);
    const list = created.json() as { id: string };
    await clearCooldown(ctx);
    const put = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/gear-lists/${list.id}/slots/head`,
      headers: { cookie, 'x-csrf-token': csrf, 'if-match': '"v1"' },
      payload: { item_id: 16846 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.headers.etag).toBe('"v2"');
    expect(put.json()).toMatchObject({ slot: 'head', item_id: 16846 });

    await clearCooldown(ctx);
    const clear = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/gear-lists/${list.id}/slots/head`,
      headers: { cookie, 'x-csrf-token': csrf, 'if-match': '"v2"' },
      payload: { item_id: null },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json()).toMatchObject({ slot: 'head', item_id: null });
    expect(clear.headers.etag).toBe('"v3"');

    const badSlot = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/gear-lists/${list.id}/slots/hat`,
      headers: { cookie, 'x-csrf-token': csrf, 'if-match': '"v3"' },
      payload: { item_id: 16846 },
    });
    expect(badSlot.statusCode).toBe(400);
    expect(badSlot.json()).toMatchObject({ error: { code: 'invalid_slot' } });

    // Clear selection → character_not_displayed on create
    const chars = await ctx.app.inject({ method: 'GET', url: '/api/v1/me/characters', headers: { cookie } });
    const other = (chars.json() as { characters: { id: string }[] }).characters.find((c) => c.id !== chosen.id);
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
