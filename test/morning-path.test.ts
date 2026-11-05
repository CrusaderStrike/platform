import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestApp, signIn, shutdownEmbeddedPg, type TestCtx } from './helpers/setup.js';
import * as foreverItems from '../src/items/store.js';

// platform#55: end-to-end morning path for #26 (local stack, mock Battle.net).
describe('morning path smoke (platform#55)', () => {
  let ctx: TestCtx;
  beforeAll(async () => {
    ctx = await startTestApp();
  });
  afterAll(async () => {
    await ctx.stop();
    await shutdownEmbeddedPg();
  });
  const cool = () => ctx.app.clearGearWriteCooldowns?.();

  it('no cookie → 401 unauthenticated; bogus cookie → session_expired + cleared', async () => {
    const none = await ctx.app.inject({ method: 'GET', url: '/api/v1/me/characters' });
    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe('unauthenticated');
    for (const v of [randomUUID(), 'garbage']) {
      const bad = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me/characters',
        headers: { cookie: `cs_session=${v}` },
      });
      expect(bad.statusCode).toBe(401);
      expect(bad.json().error.code).toBe('session_expired');
      expect(String(bad.headers['set-cookie'])).toMatch(/cs_session=;.*Max-Age=0/);
    }
  });

  it('valid session: display → gear-list CRUD → set_slot/clear_slot → items-by-slot', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const h = { cookie, 'x-csrf-token': csrf };
    for (const [itemId, name, ilvl] of [[16846, "Giantstalker's Helmet", 66], [16900, 'Stormrage Cover', 76]] as const) {
      await foreverItems.upsertItem(ctx.pool, {
        itemId, name, slot: 'head', slotAliases: [], inventoryType: 'HEAD', quality: 'epic',
        itemLevel: ilvl, requiredLevel: 60, armorType: 'mail', itemClass: 4, itemSubclass: 3,
        stats: null, iconUrl: null, iconName: null, region: 'us',
      });
    }
    await foreverItems.setMeta(ctx.pool, { buildId: 'smoke-55', itemCount: 2, region: 'us' });

    // characters/display
    const chars = await ctx.app.inject({ method: 'GET', url: '/api/v1/me/characters', headers: { cookie } });
    expect(chars.statusCode).toBe(200);
    const charId = (chars.json() as { characters: { id: string }[] }).characters[0]!.id;
    const disp = await ctx.app.inject({
      method: 'PATCH', url: `/api/v1/me/characters/${charId}`, headers: h, payload: { displayed: true },
    });
    expect(disp.statusCode).toBe(200);

    // CRUD
    await cool();
    const created = await ctx.app.inject({
      method: 'POST', url: `/api/v1/characters/${charId}/gear-lists`, headers: h,
      payload: { name: 'Morning', type: 'max_level' },
    });
    expect(created.statusCode).toBe(201);
    const list = created.json() as { id: string; version: number };
    const listed = await ctx.app.inject({ method: 'GET', url: `/api/v1/characters/${charId}/gear-lists`, headers: { cookie } });
    expect(listed.statusCode).toBe(200);
    expect(JSON.stringify(listed.json())).toContain(list.id);
    const got = await ctx.app.inject({ method: 'GET', url: `/api/v1/gear-lists/${list.id}`, headers: { cookie } });
    expect(got.statusCode).toBe(200);
    await cool();
    const renamed = await ctx.app.inject({
      method: 'PATCH', url: `/api/v1/gear-lists/${list.id}`,
      headers: { ...h, 'if-match': `"v${list.version}"` },
      payload: { name: 'Morning BiS', version: list.version },
    });
    expect(renamed.statusCode).toBe(200);
    let version = (renamed.json() as { version: number }).version;

    // set_slot / clear_slot
    await cool();
    const set = await ctx.app.inject({
      method: 'POST', url: `/api/v1/gear-lists/${list.id}/ops`, headers: h,
      payload: { ops: [{ op_id: randomUUID(), type: 'set_slot', slot: 'head', item_id: 16900, base_version: version }] },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().list.slots.head).toBe(16900);
    version = set.json().version;
    await cool();
    const clear = await ctx.app.inject({
      method: 'POST', url: `/api/v1/gear-lists/${list.id}/ops`, headers: h,
      payload: { ops: [{ op_id: randomUUID(), type: 'clear_slot', slot: 'head', base_version: version }] },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().list.slots.head ?? null).toBeNull();
    version = clear.json().version;

    // items-by-slot
    const items = await ctx.app.inject({ method: 'GET', url: '/api/v1/items?slot=head' });
    expect(items.statusCode).toBe(200);
    expect((items.json() as { items: { item_id: number }[] }).items.map((i) => i.item_id).sort()).toEqual([16846, 16900]);

    // delete
    await cool();
    const noIfMatch = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/gear-lists/${list.id}`, headers: h });
    expect(noIfMatch.statusCode).toBe(428);
    expect(noIfMatch.json().error.code).toBe('precondition_required');
    await cool();
    const del = await ctx.app.inject({
      method: 'DELETE', url: `/api/v1/gear-lists/${list.id}`, headers: { ...h, 'if-match': `"v${version}"` },
    });
    expect(del.statusCode, del.body).toBeLessThan(300);
    const gone = await ctx.app.inject({ method: 'GET', url: `/api/v1/gear-lists/${list.id}`, headers: { cookie } });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.code).toBe('not_found');
  });

  it('malformed JSON keeps the errors map and adds a human-readable message (platform#55)', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/v1/gear-lists/${randomUUID()}/ops`,
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: '{"ops":[',
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.errors).toEqual({ body: 'invalid_json' });
    expect(typeof body.message).toBe('string');
    expect(body.message).not.toMatch(/SyntaxError|Unexpected|position/);
    expect(body.error).toBeUndefined();
  });
});
