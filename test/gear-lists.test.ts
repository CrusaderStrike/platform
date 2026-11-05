import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestApp, signIn, shutdownEmbeddedPg, type TestCtx } from './helpers/setup.js';
import * as gear from '../src/gear/store.js';

async function selectMain(ctx: TestCtx, cookie: string, csrf: string) {
  const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/me/characters', headers: { cookie } });
  const body = list.json() as { characters: { id: string }[]; selection: { main_id: string } | null };
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
  return chosen.id;
}

describe('gear lists (platform#17)', () => {
  let ctx: TestCtx;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  afterAll(async () => {
    await ctx.stop();
    await shutdownEmbeddedPg();
  });
  beforeEach(async () => {
    // startTestApp truncates on each startTestApp call only once; re-truncate via helper path
    await ctx.pool.query(`
      TRUNCATE upload_rate_limits, pvp_battlegrounds, pvp_world_events, dungeon_runs,
               gear_list_events, gear_list_items, gear_lists, guild_members, guilds,
               item_icon_cache, character_gear, character_selections, characters, sessions, oauth_states, users CASCADE
    `);
  });

  it('creates lists per character, caps at 5 with 409 list_limit_reached', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);

    for (let i = 0; i < 5; i++) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/characters/${characterId}/gear-lists`,
        headers: { cookie, 'x-csrf-token': csrf },
        payload: { name: `List ${i + 1}` },
      });
      expect(res.statusCode).toBe(201);
      expect(res.headers.etag).toBe('"v1"');
      const body = res.json() as { visibility: string; updated_source: string; items: unknown[] };
      expect(body.visibility).toBe('private');
      expect(body.updated_source).toBe('web');
      expect(body.items).toEqual([]);
    }
    const sixth = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'List 6' },
    });
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json()).toMatchObject({ error: { code: 'list_limit_reached' } });

    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { items: unknown[] }).items).toHaveLength(5);
  });

  it('PATCH/DELETE use If-Match; 409 version_mismatch includes current list', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'BiS' },
    });
    const list = created.json() as { id: string; version: number };
    const ok = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/gear-lists/${list.id}`,
      headers: { cookie, 'x-csrf-token': csrf, 'if-match': '"v1"' },
      payload: { name: 'BiS v2', visibility: 'guild' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ name: 'BiS v2', visibility: 'guild', version: 2 });

    const stale = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/gear-lists/${list.id}`,
      headers: { cookie, 'x-csrf-token': csrf, 'if-match': '"v1"' },
      payload: { name: 'stale' },
    });
    expect(stale.statusCode).toBe(409);
    const body = stale.json() as {
      error: { code: string };
      current: { version: number; list: { name: string } };
    };
    expect(body.error.code).toBe('version_mismatch');
    expect(body.current.version).toBe(2);
    expect(body.current.list.name).toBe('BiS v2');
  });

  it('ops soft-ignore unknown keys, undo obtained, rebuild matches projection, idempotent re-send', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'PvE' },
    });
    const list = created.json() as { id: string; version: number };
    const opId = randomUUID();
    const add = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [
          {
            op_id: opId,
            type: 'add_item',
            slot: 'head',
            item_id: 19019,
            priority: 1,
            base_version: 1,
            source: 'web',
            synced: true, // soft-ignored
          },
        ],
      },
    });
    expect(add.statusCode).toBe(200);
    const addBody = add.json() as {
      version: number;
      applied: string[];
      ignored: { op_id: string; keys: string[] }[];
      list: { items: { item_id: number; obtained: boolean }[] };
    };
    expect(addBody.applied).toEqual([opId]);
    expect(addBody.ignored[0]).toMatchObject({ op_id: opId, keys: ['synced'] });
    expect(addBody.list.items[0]).toMatchObject({ item_id: 19019, obtained: false });

    const obtainId = randomUUID();
    const obtain = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [
          {
            op_id: obtainId,
            type: 'mark_obtained',
            slot: 'head',
            item_id: 19019,
            obtained: true,
            base_version: addBody.version,
          },
        ],
      },
    });
    expect(obtain.statusCode).toBe(200);
    expect((obtain.json() as { list: { items: { obtained: boolean }[] } }).list.items[0].obtained).toBe(
      true,
    );

    const undoId = randomUUID();
    const undo = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [
          {
            op_id: undoId,
            type: 'mark_obtained',
            slot: 'head',
            item_id: 19019,
            obtained: false,
            base_version: (obtain.json() as { version: number }).version,
          },
        ],
      },
    });
    expect(undo.statusCode).toBe(200);
    expect((undo.json() as { list: { items: { obtained: boolean }[] } }).list.items[0].obtained).toBe(
      false,
    );

    // Idempotent re-send
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [
          {
            op_id: opId,
            type: 'add_item',
            slot: 'head',
            item_id: 19019,
            priority: 1,
            base_version: 1,
          },
        ],
      },
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { duplicates: string[] }).duplicates).toEqual([opId]);

    // Rebuild from log matches projection
    const row = await ctx.pool.query<{ guild_id: string }>(
      `SELECT guild_id FROM gear_lists WHERE id = $1`,
      [list.id],
    );
    await gear.setTenant(ctx.pool, row.rows[0]!.guild_id);
    const rebuilt = await gear.rebuildFromLog(ctx.pool, list.id);
    const items = await gear.getItems(ctx.pool, list.id);
    const meta = await gear.getList(ctx.pool, list.id);
    expect(rebuilt.name).toBe(meta!.name);
    expect(rebuilt.version).toBe(Number(meta!.version));
    expect(rebuilt.items.size).toBe(items.length);
    for (const it of items) {
      const r = rebuilt.items.get(`${it.slot}:${it.item_id}`);
      expect(r).toMatchObject({
        priority: it.priority,
        obtained: it.obtained,
      });
    }
  });

  it('guild A cannot read guild B lists under RLS', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'Secret' },
    });
    const list = created.json() as { id: string };
    const row = await ctx.pool.query<{ guild_id: string }>(
      `SELECT guild_id FROM gear_lists WHERE id = $1`,
      [list.id],
    );
    const guildA = row.rows[0]!.guild_id;
    const guildB = randomUUID();
    await ctx.pool.query(`INSERT INTO guilds (id, name, kind) VALUES ($1, 'Other', 'guild')`, [
      guildB,
    ]);

    await ctx.pool.query(`SET ROLE crusaderstrike_app`);
    try {
      await ctx.pool.query(`SELECT set_config('app.guild_id', $1, false)`, [guildB]);
      const hidden = await ctx.pool.query(`SELECT id FROM gear_lists WHERE id = $1`, [list.id]);
      expect(hidden.rowCount).toBe(0);
      await ctx.pool.query(`SELECT set_config('app.guild_id', $1, false)`, [guildA]);
      const visible = await ctx.pool.query(`SELECT id FROM gear_lists WHERE id = $1`, [list.id]);
      expect(visible.rowCount).toBe(1);
    } finally {
      await ctx.pool.query(`RESET ROLE`);
      await ctx.pool.query(`SELECT set_config('app.guild_id', '', false)`);
    }
  });

  it('POST /sync accepts companion source with same op shape', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'SyncMe' },
    });
    const list = created.json() as { id: string; version: number };
    const opId = randomUUID();
    const sync = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sync',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        source: 'companion',
        characterId,
        lists: [
          {
            list_id: list.id,
            since_version: 0,
            ops: [
              {
                op_id: opId,
                type: 'add_item',
                slot: 'chest',
                item_id: 42,
                priority: 2,
                base_version: list.version,
              },
            ],
          },
        ],
      },
    });
    expect(sync.statusCode).toBe(200);
    const body = sync.json() as {
      source: string;
      gear: { result: { applied: string[] }; events: { event_type: string }[] }[];
    };
    expect(body.source).toBe('companion');
    expect(body.gear[0]!.result.applied).toEqual([opId]);
    expect(body.gear[0]!.events.some((e) => e.event_type === 'GearItemAdded')).toBe(true);
  });

  it('GET /items/search returns 501 not_implemented', async () => {
    const { cookie } = await signIn(ctx);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/items/search?q=thunder',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ error: { code: 'not_implemented' } });
  });

  it('events history includes actor display_name', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'Hist' },
    });
    const list = created.json() as { id: string };
    const ev = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/gear-lists/${list.id}/events`,
      headers: { cookie },
    });
    expect(ev.statusCode).toBe(200);
    const items = (ev.json() as { items: { actor: { display_name: string }; event_type: string }[] })
      .items;
    expect(items[0]!.event_type).toBe('GearListCreated');
    expect(items[0]!.actor.display_name).toMatch(/#/);
  });
});

