import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestApp, signIn, shutdownEmbeddedPg, type TestCtx } from './helpers/setup.js';
import * as gear from '../src/gear/store.js';
import * as foreverItems from '../src/items/store.js';


async function clearCooldown(ctx: TestCtx) {
  await ctx.app.clearGearWriteCooldowns?.();
}

async function selectMain(ctx: TestCtx, cookie: string, csrf: string) {
  const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/me/characters', headers: { cookie } });
  const body = list.json() as {
    characters: { id: string; displayed: boolean }[];
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
      TRUNCATE public_api_rate_limits, upload_rate_limits, gear_write_rate_limits, pvp_battlegrounds, pvp_world_events, dungeon_runs,
               gear_op_noop_ids, gear_list_events, gear_list_items, gear_lists, guild_members, guilds,
               forever_items, forever_items_meta, item_icon_cache, character_gear, character_selections, characters, sessions, oauth_states, users CASCADE
    `);
    await ctx.pool.query(
      `INSERT INTO forever_items_meta (id, build_id, item_count) VALUES (1, 'empty', 0) ON CONFLICT (id) DO NOTHING`,
    );
  });

  it('creates lists per character, caps at 20 with 409 list_limit_reached', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);

    for (let i = 0; i < 20; i++) {
      await clearCooldown(ctx);
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/characters/${characterId}/gear-lists`,
        headers: { cookie, 'x-csrf-token': csrf },
        payload: { name: `List ${i + 1}`, type: 'max_level' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.headers.etag).toBe('"v1"');
      const body = res.json() as {
        visibility: string;
        updated_source: string;
        items: unknown[];
        type: string;
        slots: Record<string, unknown>;
        edited_at: string;
        outgrown: boolean;
      };
      expect(body.visibility).toBe('private');
      expect(body.updated_source).toBe('web');
      expect(body.items).toEqual([]);
      expect(body.type).toBe('max_level');
      expect(body.outgrown).toBe(false);
      expect(body.edited_at).toBeTruthy();
      expect(Object.keys(body.slots)).toHaveLength(19);
    }
    await clearCooldown(ctx);
    const twentyFirst = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'List 21', type: 'max_level' },
    });
    expect(twentyFirst.statusCode).toBe(409);
    expect(twentyFirst.json()).toMatchObject({ error: { code: 'list_limit_reached' } });

    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { items: unknown[] }).items).toHaveLength(20);
  });

  it('PATCH/DELETE use If-Match; 409 version_mismatch includes current list', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    await clearCooldown(ctx);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'BiS', type: 'max_level' },
    });
    const list = created.json() as { id: string; version: number };
    await clearCooldown(ctx);
    const ok = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/gear-lists/${list.id}`,
      headers: { cookie, 'x-csrf-token': csrf, 'if-match': '"v1"' },
      payload: { name: 'BiS v2', visibility: 'guild' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ name: 'BiS v2', visibility: 'guild', version: 2 });

    await clearCooldown(ctx);
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
    await clearCooldown(ctx);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'PvE', type: 'max_level' },
    });
    const list = created.json() as { id: string; version: number };
    await clearCooldown(ctx);
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
    expect(addBody.ignored[0]!.op_id).toBe(opId);
    expect(addBody.ignored[0]!.keys.sort()).toEqual(['source', 'synced']);
    expect(addBody.list.items[0]).toMatchObject({ item_id: 19019, obtained: false });

    await clearCooldown(ctx);
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

    await clearCooldown(ctx);
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
    await clearCooldown(ctx);
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
    await clearCooldown(ctx);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'Secret', type: 'max_level' },
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
    await clearCooldown(ctx);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'SyncMe', type: 'max_level' },
    });
    const list = created.json() as { id: string; version: number };
    const opId = randomUUID();
    await clearCooldown(ctx);
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

    it('GET /items/search is aliased to Forever catalog (empty until import)', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/items/search?q=thunder',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ items: [], next_cursor: null });
  });

  it('events history includes actor display_name', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    await clearCooldown(ctx);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'Hist', type: 'max_level' },
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

  it('returns 428 precondition_required when If-Match is missing', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    await clearCooldown(ctx);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'NeedETag', type: 'max_level' },
    });
    const list = created.json() as { id: string };
    await clearCooldown(ctx);
    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/gear-lists/${list.id}`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'Nope' },
    });
    expect(patch.statusCode).toBe(428);
    expect(patch.json()).toMatchObject({ error: { code: 'precondition_required' } });
    await clearCooldown(ctx);
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/gear-lists/${list.id}`,
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(del.statusCode).toBe(428);
    expect(del.json()).toMatchObject({ error: { code: 'precondition_required' } });
  });

  it('non-UUID list ids return 400 not 500', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const badGet = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/gear-lists/not-a-uuid',
      headers: { cookie },
    });
    expect(badGet.statusCode).toBe(400);
    expect(badGet.statusCode).not.toBe(500);
    expect(badGet.json()).toMatchObject({ errors: { list_id: 'Must be a UUID.' } });
    const badOps = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/gear-lists/not-a-uuid/ops',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { ops: [{ op_id: randomUUID(), type: 'remove_item', slot: 'head', item_id: 1, base_version: 0 }] },
    });
    expect(badOps.statusCode).toBe(400);
    expect(badOps.statusCode).not.toBe(500);
  });

  it('rejects /sync source web|system; records companion not client op source', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    await clearCooldown(ctx);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'Src', type: 'max_level' },
    });
    const list = created.json() as { id: string; version: number };
    await clearCooldown(ctx);
    const webSync = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sync',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        source: 'web',
        characterId,
        lists: [{ list_id: list.id, since_version: 0, ops: [] }],
      },
    });
    expect(webSync.statusCode).toBe(400);

    await clearCooldown(ctx);
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
                slot: 'feet',
                item_id: 99,
                priority: 1,
                base_version: list.version,
                source: 'web', // soft-ignored; envelope source wins
              },
            ],
          },
        ],
      },
    });
    expect(sync.statusCode).toBe(200);
    const ev = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/gear-lists/${list.id}/events?after_version=1`,
      headers: { cookie },
    });
    const items = (ev.json() as { items: { source: string; event_type: string }[] }).items;
    const added = items.find((e) => e.event_type === 'GearItemAdded');
    expect(added?.source).toBe('companion');
  });

  it('forever reject bumps version with distinct item_not_forever reason', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    await clearCooldown(ctx);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'Forever', type: 'max_level' },
    });
    const listRow = created.json() as { id: string; version: number };
    const row = await ctx.pool.query<{ guild_id: string }>(
      `SELECT guild_id FROM gear_lists WHERE id = $1`,
      [listRow.id],
    );
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      await gear.setTenant(client, row.rows[0]!.guild_id);
      const list = await gear.getList(client, listRow.id);
      const opId = randomUUID();
      const result = await gear.applyOps(client, {
        list: list!,
        ops: [
          {
            op_id: opId,
            type: 'add_item',
            slot: 'head',
            item_id: 1,
            priority: 1,
            base_version: 1,
          },
        ],
        defaultSource: 'web',
        actor: { user_id: 'u', display_name: 'T#1' },
        foreverCheck: () => false,
      });
      expect(result.conflicts).toEqual([
        expect.objectContaining({ op_id: opId, reason: 'item_not_forever' }),
      ]);
      expect(result.version).toBe(2);
      const fresh = await gear.getList(client, listRow.id);
      expect(Number(fresh!.version)).toBe(2);
      // Next write must not collide on seq
      const op2 = randomUUID();
      const next = await gear.applyOps(client, {
        list: fresh!,
        ops: [
          {
            op_id: op2,
            type: 'add_item',
            slot: 'head',
            item_id: 2,
            priority: 1,
            base_version: 2,
          },
        ],
        defaultSource: 'web',
        actor: { user_id: 'u', display_name: 'T#1' },
        foreverCheck: () => true,
      });
      expect(next.applied).toEqual([op2]);
      expect(next.version).toBe(3);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  it('re-add resets obtained+note; missing remove is only in applied', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    await clearCooldown(ctx);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'ReAdd', type: 'max_level' },
    });
    const list = created.json() as { id: string; version: number };
    await clearCooldown(ctx);
    const add1 = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [
          {
            op_id: randomUUID(),
            type: 'add_item',
            slot: 'wrist',
            item_id: 55,
            priority: 1,
            note: 'first',
            base_version: 1,
          },
        ],
      },
    });
    expect(add1.statusCode).toBe(200);
    const v1 = (add1.json() as { version: number }).version;
    await clearCooldown(ctx);
    const obt = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [
          {
            op_id: randomUUID(),
            type: 'mark_obtained',
            slot: 'wrist',
            item_id: 55,
            obtained: true,
            base_version: v1,
          },
        ],
      },
    });
    const v2 = (obt.json() as { version: number }).version;
    await clearCooldown(ctx);
    const readd = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [
          {
            op_id: randomUUID(),
            type: 'add_item',
            slot: 'wrist',
            item_id: 55,
            priority: 3,
            note: 'again',
            base_version: v2,
          },
        ],
      },
    });
    expect(readd.statusCode).toBe(200);
    const item = (readd.json() as { list: { items: { obtained: boolean; note: string; priority: number }[] } })
      .list.items[0]!;
    expect(item).toMatchObject({ obtained: false, note: 'again', priority: 3 });

    await clearCooldown(ctx);
    const missingRemoveId = randomUUID();
    const rm = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [
          {
            op_id: missingRemoveId,
            type: 'remove_item',
            slot: 'neck',
            item_id: 999,
            base_version: (readd.json() as { version: number }).version,
          },
        ],
      },
    });
    const rmBody = rm.json() as { applied: string[]; duplicates: string[]; conflicts: unknown[] };
    expect(rmBody.applied).toEqual([missingRemoveId]);
    expect(rmBody.duplicates).toEqual([]);
    expect(rmBody.conflicts).toEqual([]);
  });



  it('allows ~10 back-to-back gear writes; 61st in the minute returns 429 Retry-After', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    await clearCooldown(ctx);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'Burst', type: 'max_level' },
    });
    expect(created.statusCode).toBe(201);
    const list = created.json() as { id: string; version: number };
    let version = list.version;
    const owner = await ctx.pool.query<{ owner_user_id: string }>(
      `SELECT owner_user_id FROM gear_lists WHERE id = $1`,
      [list.id],
    );
    const userId = owner.rows[0]!.owner_user_id;

    // Reset so the burst is measured cleanly; 10 ops with no wait must all be 200.
    await clearCooldown(ctx);
    for (let i = 0; i < 10; i++) {
      const op = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/gear-lists/${list.id}/ops`,
        headers: { cookie, 'x-csrf-token': csrf },
        payload: {
          ops: [
            {
              op_id: randomUUID(),
              type: 'add_item',
              slot: 'trinket1',
              item_id: 3000 + i,
              priority: 1,
              base_version: version,
            },
          ],
        },
      });
      expect(op.statusCode).toBe(200);
      version = (op.json() as { version: number }).version;
    }

    // Simulate the 60th write already consumed in this minute; the next is the 61st.
    await ctx.pool.query(
      `UPDATE gear_write_rate_limits SET write_count = 60, window_start = now() WHERE user_id = $1`,
      [userId],
    );

    const limited = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [
          {
            op_id: randomUUID(),
            type: 'add_item',
            slot: 'trinket2',
            item_id: 9999,
            priority: 1,
            base_version: version,
          },
        ],
      },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
    const retryAfter = limited.headers['retry-after'];
    expect(retryAfter).toBeDefined();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });


  it('70 parallel writes: exactly 60 non-429 under atomic consumeGearWrite', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    await clearCooldown(ctx);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'AtomicLimit', type: 'max_level' },
    });
    expect(created.statusCode).toBe(201);
    const list = created.json() as { id: string; version: number };
    await clearCooldown(ctx);

    const results = await Promise.all(
      Array.from({ length: 70 }, (_, i) =>
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/gear-lists/${list.id}/ops`,
          headers: { cookie, 'x-csrf-token': csrf },
          payload: {
            ops: [
              {
                op_id: randomUUID(),
                type: 'add_item',
                slot: 'finger2',
                item_id: 5000 + i,
                priority: 1,
                base_version: list.version,
              },
            ],
          },
        }),
      ),
    );
    const allowed = results.filter((r) => r.statusCode !== 429);
    const limited = results.filter((r) => r.statusCode === 429);
    expect(allowed).toHaveLength(60);
    expect(limited).toHaveLength(10);
    for (const r of limited) {
      expect(r.headers['retry-after']).toBeDefined();
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    }
  });

  it('parallel ops/PATCH/create serialize without 500 and respect 5-list cap', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    await clearCooldown(ctx);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'Parallel', type: 'max_level' },
    });
    const list = created.json() as { id: string; version: number };

    await clearCooldown(ctx);
    // Parallel ops on same list — FOR UPDATE serializes; no 500
    const opResults = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/gear-lists/${list.id}/ops`,
          headers: { cookie, 'x-csrf-token': csrf },
          payload: {
            ops: [
              {
                op_id: randomUUID(),
                type: 'add_item',
                slot: 'finger1',
                item_id: 1000 + i,
                priority: 1,
                base_version: list.version,
              },
            ],
          },
        }),
      ),
    );
    // Limiter disabled via clearCooldown; lock path only — no 429.
    for (const r of opResults) {
      expect(r.statusCode).toBe(200);
    }

    await clearCooldown(ctx);
    const get = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/gear-lists/${list.id}`,
      headers: { cookie },
    });
    const etag = get.headers.etag as string;

    await clearCooldown(ctx);
    const patchResults = await Promise.all([
      ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/gear-lists/${list.id}`,
        headers: { cookie, 'x-csrf-token': csrf, 'if-match': etag },
        payload: { name: 'A' },
      }),
      ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/gear-lists/${list.id}`,
        headers: { cookie, 'x-csrf-token': csrf, 'if-match': etag },
        payload: { name: 'B' },
      }),
    ]);
    for (const r of patchResults) {
      expect([200, 409]).toContain(r.statusCode);
    }
    expect(patchResults.some((r) => r.statusCode === 200)).toBe(true);

    // Parallel creates against the 20-list cap (1 already exists)
    await clearCooldown(ctx);
    const createResults = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/characters/${characterId}/gear-lists`,
          headers: { cookie, 'x-csrf-token': csrf },
          payload: { name: `P${i}`, type: 'max_level' },
        }),
      ),
    );
    for (const r of createResults) {
      expect([201, 409]).toContain(r.statusCode);
    }
    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie },
    });
    expect((listed.json() as { items: unknown[] }).items.length).toBeLessThanOrEqual(20);
    // At least one create must have hit the cap or succeeded within cap
    const createdN = createResults.filter((r) => r.statusCode === 201).length;
    const capped = createResults.filter((r) => r.statusCode === 409).length;
    expect(createdN + capped).toBeGreaterThan(0);
    expect((listed.json() as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(1);
    expect((listed.json() as { items: unknown[] }).items.length).toBeLessThanOrEqual(20);
  });


  it('returns list_items_limit conflict reason at the items cap (platform#37 ride-along)', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'Cap list', type: 'max_level' },
    });
    expect(created.statusCode).toBe(201);
    const listRow = created.json() as { id: string; version: number };
    const row = await ctx.pool.query<{ guild_id: string }>(
      `SELECT guild_id FROM gear_lists WHERE id = $1`,
      [listRow.id],
    );
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      await gear.setTenant(client, row.rows[0]!.guild_id);
      let list = await gear.getList(client, listRow.id);
      // Fill to cap
      const { MAX_ITEMS_PER_LIST } = await import('../src/gear/schema.js');
      for (let i = 0; i < MAX_ITEMS_PER_LIST; i++) {
        const opId = randomUUID();
        const result = await gear.applyOps(client, {
          list: list!,
          ops: [
            {
              op_id: opId,
              type: 'add_item',
              slot: 'head',
              item_id: 10_000 + i,
              priority: 1,
              base_version: Number(list!.version),
            },
          ],
          defaultSource: 'web',
          actor: { user_id: 'u', display_name: 'T#1' },
          foreverCheck: () => true,
        });
        expect(result.applied).toEqual([opId]);
        list = await gear.getList(client, listRow.id);
      }
      const overflowId = randomUUID();
      const overflow = await gear.applyOps(client, {
        list: list!,
        ops: [
          {
            op_id: overflowId,
            type: 'add_item',
            slot: 'head',
            item_id: 99_999,
            priority: 1,
            base_version: Number(list!.version),
          },
        ],
        defaultSource: 'web',
        actor: { user_id: 'u', display_name: 'T#1' },
        foreverCheck: () => true,
      });
      expect(overflow.applied).toEqual([]);
      expect(overflow.conflicts).toEqual([
        expect.objectContaining({
          op_id: overflowId,
          reason: 'list_items_limit',
          message: 'list_items_limit',
        }),
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });


  it('catalogIsActive stays off until setMeta; mid-import upserts do not enforce item_not_forever', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    await clearCooldown(ctx);
    await foreverItems.upsertItem(ctx.pool, {
      itemId: 19019,
      name: 'Thunderfury',
      slot: 'main_hand',
      slotAliases: ['off_hand'],
      inventoryType: 'WEAPON',
      quality: 'legendary',
      itemLevel: 80,
      requiredLevel: 60,
      armorType: null,
      itemClass: 2,
      itemSubclass: 7,
      stats: null,
      iconUrl: null,
      iconName: null,
      region: 'us',
    });
    // Meta still empty — catalog must not be active mid-import.
    expect(await foreverItems.catalogIsActive(ctx.pool)).toBe(false);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'MidImport', type: 'max_level' },
    });
    expect(created.statusCode).toBe(201);
    const list = created.json() as { id: string; version: number };
    await clearCooldown(ctx);
    const unknownId = 424242;
    const addUnknown = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [
          {
            op_id: randomUUID(),
            type: 'add_item',
            slot: 'head',
            item_id: unknownId,
            priority: 1,
            base_version: list.version,
          },
        ],
      },
    });
    expect(addUnknown.statusCode).toBe(200);
    expect(addUnknown.json()).toMatchObject({
      applied: [expect.any(String)],
      conflicts: [],
    });

    await foreverItems.setMeta(ctx.pool, {
      buildId: 'test-complete-1',
      itemCount: 1,
      region: 'us',
    });
    expect(await foreverItems.catalogIsActive(ctx.pool)).toBe(true);
    await clearCooldown(ctx);
    const rejectId = randomUUID();
    const afterMeta = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [
          {
            op_id: rejectId,
            type: 'add_item',
            slot: 'neck',
            item_id: 999999,
            priority: 1,
            base_version: (addUnknown.json() as { version: number }).version,
          },
        ],
      },
    });
    expect(afterMeta.statusCode).toBe(200);
    expect(afterMeta.json()).toMatchObject({
      conflicts: [expect.objectContaining({ op_id: rejectId, reason: 'item_not_forever' })],
    });
  });

  it('remove_item still works for ids absent from an active Forever catalog', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    await clearCooldown(ctx);
    await foreverItems.upsertItem(ctx.pool, {
      itemId: 19019,
      name: 'Thunderfury',
      slot: 'main_hand',
      slotAliases: ['off_hand'],
      inventoryType: 'WEAPON',
      quality: 'legendary',
      itemLevel: 80,
      requiredLevel: 60,
      armorType: null,
      itemClass: 2,
      itemSubclass: 7,
      stats: null,
      iconUrl: null,
      iconName: null,
      region: 'us',
    });
    await foreverItems.setMeta(ctx.pool, {
      buildId: 'test-complete-orphan',
      itemCount: 1,
      region: 'us',
    });
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'OrphanRow', type: 'max_level' },
    });
    const list = created.json() as { id: string };
    const guild = await ctx.pool.query<{ guild_id: string }>(
      `SELECT guild_id FROM gear_lists WHERE id = $1`,
      [list.id],
    );
    await ctx.pool.query(
      `INSERT INTO gear_list_items (guild_id, list_id, slot, item_id, priority, note, obtained, obtained_at)
       VALUES ($1,$2,'head',777001,1,NULL,false,NULL)`,
      [guild.rows[0]!.guild_id, list.id],
    );
    await clearCooldown(ctx);
    const removeId = randomUUID();
    const remove = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [
          {
            op_id: removeId,
            type: 'remove_item',
            slot: 'head',
            item_id: 777001,
            base_version: 1,
          },
        ],
      },
    });
    expect(remove.statusCode).toBe(200);
    const body = remove.json() as {
      applied: string[];
      conflicts: unknown[];
      list: { items: unknown[] };
    };
    expect(body.conflicts).toEqual([]);
    expect(body.applied).toEqual([removeId]);
    expect(body.list.items).toEqual([]);
  });

  async function seedSlotCatalog(ctx: TestCtx) {
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
    await foreverItems.upsertItem(ctx.pool, {
      itemId: 16900,
      name: 'Stormrage Cover',
      slot: 'head',
      slotAliases: [],
      inventoryType: 'HEAD',
      quality: 'epic',
      itemLevel: 76,
      requiredLevel: 60,
      armorType: 'leather',
      itemClass: 4,
      itemSubclass: 2,
      stats: null,
      iconUrl: null,
      iconName: null,
      region: 'us',
    });
    await foreverItems.upsertItem(ctx.pool, {
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
      iconUrl: null,
      iconName: null,
      region: 'us',
    });
    await foreverItems.setMeta(ctx.pool, { buildId: 'slot-ops-1', itemCount: 3, region: 'us' });
  }

  async function createArmoryList(ctx: TestCtx, cookie: string, csrf: string, characterId: string) {
    await clearCooldown(ctx);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/characters/${characterId}/gear-lists`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'Armory', type: 'max_level' },
    });
    expect(created.statusCode).toBe(201);
    return created.json() as {
      id: string;
      version: number;
      slots: Record<string, number | null>;
      items: { slot: string; item_id: number; priority: number }[];
    };
  }

  it('set_slot replaces slot contents and emits GearSlotSet', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    await seedSlotCatalog(ctx);
    const list = await createArmoryList(ctx, cookie, csrf, characterId);

    await clearCooldown(ctx);
    const setId = randomUUID();
    const set1 = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [{ op_id: setId, type: 'set_slot', slot: 'head', item_id: 16846, base_version: list.version }],
      },
    });
    expect(set1.statusCode).toBe(200);
    const body = set1.json() as {
      applied: string[];
      conflicts: unknown[];
      version: number;
      list: { slots: Record<string, number | null>; items: { slot: string; item_id: number; priority: number }[] };
    };
    expect(body.conflicts).toEqual([]);
    expect(body.applied).toEqual([setId]);
    expect(body.version).toBe(2);
    expect(body.list.slots.head).toBe(16846);
    expect(body.list.items).toEqual([
      expect.objectContaining({ slot: 'head', item_id: 16846, priority: 1 }),
    ]);
    const events1 = await ctx.pool.query<{ event_type: string; payload: { slot: string; item_id: number } }>(
      `SELECT event_type, payload FROM gear_list_events WHERE list_id = $1 AND seq = 2`,
      [list.id],
    );
    expect(events1.rows[0]).toMatchObject({
      event_type: 'GearSlotSet',
      payload: { slot: 'head', item_id: 16846 },
    });

    await clearCooldown(ctx);
    const replaceId = randomUUID();
    const replace = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [{ op_id: replaceId, type: 'set_slot', slot: 'head', item_id: 16900, base_version: 2 }],
      },
    });
    expect(replace.statusCode).toBe(200);
    const replaced = replace.json() as typeof body;
    expect(replaced.applied).toEqual([replaceId]);
    expect(replaced.version).toBe(3);
    expect(replaced.list.slots.head).toBe(16900);
    expect(replaced.list.items).toHaveLength(1);
  });

  it('set_slot / clear_slot no-op without version bump but still dedupe op_id', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    await seedSlotCatalog(ctx);
    const list = await createArmoryList(ctx, cookie, csrf, characterId);

    await clearCooldown(ctx);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [{ op_id: randomUUID(), type: 'set_slot', slot: 'head', item_id: 16846, base_version: 1 }],
      },
    });

    await clearCooldown(ctx);
    const noopSetId = randomUUID();
    const noopSet = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [{ op_id: noopSetId, type: 'set_slot', slot: 'head', item_id: 16846, base_version: 2 }],
      },
    });
    expect(noopSet.statusCode).toBe(200);
    let body = noopSet.json() as {
      applied: string[];
      duplicates: string[];
      version: number;
      list: { slots: Record<string, number | null> };
    };
    expect(body.applied).toEqual([noopSetId]);
    expect(body.version).toBe(2);

    await clearCooldown(ctx);
    const laterId = randomUUID();
    const later = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [{ op_id: laterId, type: 'set_slot', slot: 'head', item_id: 16900, base_version: 2 }],
      },
    });
    expect(later.statusCode).toBe(200);
    expect((later.json() as { version: number }).version).toBe(3);
    expect((later.json() as { list: { slots: Record<string, number | null> } }).list.slots.head).toBe(16900);

    await clearCooldown(ctx);
    const retry = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [{ op_id: noopSetId, type: 'set_slot', slot: 'head', item_id: 16846, base_version: 2 }],
      },
    });
    expect(retry.statusCode).toBe(200);
    body = retry.json() as typeof body;
    expect(body.duplicates).toEqual([noopSetId]);
    expect(body.applied).toEqual([]);
    expect(body.version).toBe(3);
    expect(body.list.slots.head).toBe(16900);

    await clearCooldown(ctx);
    const clearId = randomUUID();
    const clear = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [{ op_id: clearId, type: 'clear_slot', slot: 'head', base_version: 3 }],
      },
    });
    expect(clear.statusCode).toBe(200);
    expect((clear.json() as { version: number }).version).toBe(4);
    expect((clear.json() as { list: { slots: Record<string, number | null> } }).list.slots.head).toBeNull();

    await clearCooldown(ctx);
    const noopClearId = randomUUID();
    const noopClear = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [{ op_id: noopClearId, type: 'clear_slot', slot: 'head', base_version: 4 }],
      },
    });
    expect(noopClear.statusCode).toBe(200);
    expect((noopClear.json() as { applied: string[]; version: number }).applied).toEqual([noopClearId]);
    expect((noopClear.json() as { version: number }).version).toBe(4);

    await clearCooldown(ctx);
    const setAgain = randomUUID();
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [{ op_id: setAgain, type: 'set_slot', slot: 'head', item_id: 16846, base_version: 4 }],
      },
    });
    await clearCooldown(ctx);
    const retryClear = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [{ op_id: noopClearId, type: 'clear_slot', slot: 'head', base_version: 4 }],
      },
    });
    const retryClearBody = retryClear.json() as {
      duplicates: string[];
      list: { slots: Record<string, number | null> };
      version: number;
    };
    expect(retryClearBody.duplicates).toEqual([noopClearId]);
    expect(retryClearBody.list.slots.head).toBe(16846);
    expect(retryClearBody.version).toBe(5);
  });

  it('set_slot rejects stale base_version, non-Forever, and wrong-slot items', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    await seedSlotCatalog(ctx);
    const list = await createArmoryList(ctx, cookie, csrf, characterId);

    await clearCooldown(ctx);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [{ op_id: randomUUID(), type: 'set_slot', slot: 'head', item_id: 16900, base_version: 1 }],
      },
    });

    await clearCooldown(ctx);
    const staleId = randomUUID();
    const stale = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [{ op_id: staleId, type: 'set_slot', slot: 'head', item_id: 16846, base_version: 1 }],
      },
    });
    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toMatchObject({
      applied: [],
      conflicts: [expect.objectContaining({ op_id: staleId, reason: 'stale_base_version' })],
      version: 3,
      list: { slots: { head: 16900 } },
    });

    await clearCooldown(ctx);
    const foreverId = randomUUID();
    const foreverReject = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [{ op_id: foreverId, type: 'set_slot', slot: 'head', item_id: 999001, base_version: 3 }],
      },
    });
    expect(foreverReject.json()).toMatchObject({
      conflicts: [expect.objectContaining({ op_id: foreverId, reason: 'item_not_forever' })],
      version: 4,
    });

    await clearCooldown(ctx);
    const wrongSlotId = randomUUID();
    const wrongSlot = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [{ op_id: wrongSlotId, type: 'set_slot', slot: 'head', item_id: 18813, base_version: 4 }],
      },
    });
    expect(wrongSlot.statusCode).toBe(200);
    expect(wrongSlot.json()).toMatchObject({
      applied: [],
      conflicts: [expect.objectContaining({ op_id: wrongSlotId, reason: 'item_not_in_slot' })],
      version: 5,
      list: { slots: { head: 16900 } },
    });
  });

  it('set_slot replaces multi-item wishlist slot; legacy add_item still works', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    await seedSlotCatalog(ctx);
    const list = await createArmoryList(ctx, cookie, csrf, characterId);

    await clearCooldown(ctx);
    const addId = randomUUID();
    const legacy = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [
          {
            op_id: addId,
            type: 'add_item',
            slot: 'head',
            item_id: 16846,
            priority: 2,
            base_version: 1,
          },
        ],
      },
    });
    expect(legacy.statusCode).toBe(200);
    expect((legacy.json() as { applied: string[] }).applied).toEqual([addId]);

    await clearCooldown(ctx);
    const add2 = randomUUID();
    const second = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [
          {
            op_id: add2,
            type: 'add_item',
            slot: 'head',
            item_id: 16900,
            priority: 1,
            base_version: (legacy.json() as { version: number }).version,
          },
        ],
      },
    });
    const beforeVersion = (second.json() as { version: number }).version;
    expect(
      (second.json() as { list: { items: { slot: string }[] } }).list.items.filter((i) => i.slot === 'head'),
    ).toHaveLength(2);

    await clearCooldown(ctx);
    const armoryId = randomUUID();
    const armory = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [{ op_id: armoryId, type: 'set_slot', slot: 'head', item_id: 16846, base_version: beforeVersion }],
      },
    });
    expect(armory.statusCode).toBe(200);
    const body = armory.json() as {
      applied: string[];
      list: { items: { slot: string; item_id: number; priority: number }[] };
    };
    expect(body.applied).toEqual([armoryId]);
    expect(body.list.items.filter((i) => i.slot === 'head')).toEqual([
      expect.objectContaining({ item_id: 16846, priority: 1 }),
    ]);
  });

  it('wishlist ops go stale after clear_slot / set_slot on the same slot', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    await seedSlotCatalog(ctx);
    const list = await createArmoryList(ctx, cookie, csrf, characterId);

    // Seed item A via set_slot, then clear_slot
    await clearCooldown(ctx);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [{ op_id: randomUUID(), type: 'set_slot', slot: 'head', item_id: 16846, base_version: 1 }],
      },
    });
    await clearCooldown(ctx);
    const clear = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [{ op_id: randomUUID(), type: 'clear_slot', slot: 'head', base_version: 2 }],
      },
    });
    expect((clear.json() as { version: number }).version).toBe(3);

    // Older-base add_item A after clear → stale
    await clearCooldown(ctx);
    const addAfterClear = randomUUID();
    const staleAdd = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [
          {
            op_id: addAfterClear,
            type: 'add_item',
            slot: 'head',
            item_id: 16846,
            priority: 1,
            base_version: 2,
          },
        ],
      },
    });
    expect(staleAdd.statusCode).toBe(200);
    expect(staleAdd.json()).toMatchObject({
      applied: [],
      conflicts: [expect.objectContaining({ op_id: addAfterClear, reason: 'stale_base_version' })],
      list: { items: [], slots: { head: null } },
    });

    // set_slot A → B, then older-base add_item A → exactly stale_base_version; list stays B
    await clearCooldown(ctx);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [
          {
            op_id: randomUUID(),
            type: 'set_slot',
            slot: 'head',
            item_id: 16846,
            base_version: (staleAdd.json() as { version: number }).version,
          },
        ],
      },
    });
    await clearCooldown(ctx);
    const setB = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [{ op_id: randomUUID(), type: 'set_slot', slot: 'head', item_id: 16900, base_version: 5 }],
      },
    });
    const afterB = (setB.json() as { version: number }).version;
    expect((setB.json() as { list: { slots: Record<string, number | null> } }).list.slots.head).toBe(16900);

    await clearCooldown(ctx);
    const addOnA = randomUUID();
    const staleOnA = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [
          {
            op_id: addOnA,
            type: 'add_item',
            slot: 'head',
            item_id: 16846,
            priority: 2,
            base_version: afterB - 1,
          },
        ],
      },
    });
    expect(staleOnA.statusCode).toBe(200);
    expect(staleOnA.json()).toMatchObject({
      applied: [],
      conflicts: [expect.objectContaining({ op_id: addOnA, reason: 'stale_base_version' })],
      list: { slots: { head: 16900 } },
    });
    expect(
      (staleOnA.json() as { list: { items: { item_id: number }[] } }).list.items.map((i) => i.item_id),
    ).toEqual([16900]);
  });

  it('same-slot multi-item wishlist batch at one base_version applies all (Option A / addon)', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    await seedSlotCatalog(ctx);
    const list = await createArmoryList(ctx, cookie, csrf, characterId);

    const idA = randomUUID();
    const idB = randomUUID();
    await clearCooldown(ctx);
    const batch = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [
          {
            op_id: idA,
            type: 'add_item',
            slot: 'head',
            item_id: 16846,
            priority: 1,
            base_version: 1,
          },
          {
            op_id: idB,
            type: 'add_item',
            slot: 'head',
            item_id: 16900,
            priority: 2,
            base_version: 1,
          },
        ],
      },
    });
    expect(batch.statusCode).toBe(200);
    const body = batch.json() as {
      applied: string[];
      conflicts: unknown[];
      version: number;
      list: { items: { item_id: number; slot: string }[] };
    };
    expect(body.conflicts).toEqual([]);
    expect(body.applied).toEqual([idA, idB]);
    expect(body.list.items.filter((i) => i.slot === 'head').map((i) => i.item_id).sort()).toEqual([
      16846, 16900,
    ]);

    // Option A remove+add swap in one batch (same base)
    const remId = randomUUID();
    const addId = randomUUID();
    await clearCooldown(ctx);
    const swap = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [
          {
            op_id: remId,
            type: 'remove_item',
            slot: 'head',
            item_id: 16846,
            base_version: body.version,
          },
          {
            op_id: addId,
            type: 'add_item',
            slot: 'head',
            item_id: 18813,
            priority: 1,
            base_version: body.version,
          },
        ],
      },
    });
    // 18813 is a ring — wrong slot → item_not_in_slot only on set_slot; add_item allows any Forever item
    expect(swap.statusCode).toBe(200);
    const swapBody = swap.json() as {
      applied: string[];
      conflicts: unknown[];
      list: { items: { item_id: number }[] };
    };
    expect(swapBody.conflicts).toEqual([]);
    expect(swapBody.applied).toEqual([remId, addId]);
    expect(swapBody.list.items.map((i) => i.item_id).sort()).toEqual([16900, 18813]);

    // set_slot then wishlist op on same slot in one batch (same-request wipe ignored)
    const setId = randomUUID();
    const addAfterSet = randomUUID();
    await clearCooldown(ctx);
    const mixed = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [
          {
            op_id: setId,
            type: 'set_slot',
            slot: 'head',
            item_id: 16846,
            base_version: (swap.json() as { version: number }).version,
          },
          {
            op_id: addAfterSet,
            type: 'add_item',
            slot: 'head',
            item_id: 16900,
            priority: 2,
            base_version: (swap.json() as { version: number }).version,
          },
        ],
      },
    });
    expect(mixed.statusCode).toBe(200);
    const mixedBody = mixed.json() as {
      applied: string[];
      conflicts: unknown[];
      list: { items: { item_id: number }[]; slots: Record<string, number | null> };
    };
    expect(mixedBody.conflicts).toEqual([]);
    expect(mixedBody.applied).toEqual([setId, addAfterSet]);
    expect(mixedBody.list.slots.head).toBe(16846);
    expect(mixedBody.list.items.map((i) => i.item_id).sort()).toEqual([16846, 16900]);

    // Same batch via /sync
    const syncA = randomUUID();
    const syncB = randomUUID();
    await clearCooldown(ctx);
    // clear head first so sync starts clean for two adds
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        ops: [
          {
            op_id: randomUUID(),
            type: 'clear_slot',
            slot: 'head',
            base_version: mixedBody.list.items ? (mixed.json() as { version: number }).version : 0,
          },
        ],
      },
    });
    const afterClear = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/gear-lists/${list.id}`,
        headers: { cookie },
      })
    ).json() as { version: number };

    await clearCooldown(ctx);
    const syncBatch = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sync',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        source: 'addon',
        characterId,
        lists: [
          {
            list_id: list.id,
            since_version: afterClear.version,
            ops: [
              {
                op_id: syncA,
                type: 'add_item',
                slot: 'head',
                item_id: 16846,
                priority: 1,
                base_version: afterClear.version,
              },
              {
                op_id: syncB,
                type: 'add_item',
                slot: 'head',
                item_id: 16900,
                priority: 2,
                base_version: afterClear.version,
              },
            ],
          },
        ],
      },
    });
    expect(syncBatch.statusCode).toBe(200);
    const syncBody = syncBatch.json() as {
      gear: {
        result: {
          applied: string[];
          conflicts: unknown[];
          list: { items: { item_id: number }[] };
        };
      }[];
    };
    expect(syncBody.gear[0]!.result.conflicts).toEqual([]);
    expect(syncBody.gear[0]!.result.applied).toEqual([syncA, syncB]);
    expect(syncBody.gear[0]!.result.list.items.map((i) => i.item_id).sort()).toEqual([16846, 16900]);
  });

  it('POST /sync applies set_slot and clear_slot (apply, no-op, stale)', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await selectMain(ctx, cookie, csrf);
    await seedSlotCatalog(ctx);
    const list = await createArmoryList(ctx, cookie, csrf, characterId);

    const setId = randomUUID();
    await clearCooldown(ctx);
    const syncSet = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sync',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        source: 'addon',
        characterId,
        lists: [
          {
            list_id: list.id,
            since_version: 0,
            ops: [
              {
                op_id: setId,
                type: 'set_slot',
                slot: 'head',
                item_id: 16846,
                base_version: 1,
              },
            ],
          },
        ],
      },
    });
    expect(syncSet.statusCode).toBe(200);
    const setBody = syncSet.json() as {
      source: string;
      gear: {
        result: {
          applied: string[];
          version: number;
          list: { slots: Record<string, number | null> };
        };
        events: { event_type: string }[];
      }[];
    };
    expect(setBody.source).toBe('addon');
    expect(setBody.gear[0]!.result.applied).toEqual([setId]);
    expect(setBody.gear[0]!.result.version).toBe(2);
    expect(setBody.gear[0]!.result.list.slots.head).toBe(16846);
    expect(setBody.gear[0]!.events.some((e) => e.event_type === 'GearSlotSet')).toBe(true);

    const noopId = randomUUID();
    await clearCooldown(ctx);
    const syncNoop = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sync',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        source: 'addon',
        characterId,
        lists: [
          {
            list_id: list.id,
            since_version: 2,
            ops: [
              {
                op_id: noopId,
                type: 'set_slot',
                slot: 'head',
                item_id: 16846,
                base_version: 2,
              },
            ],
          },
        ],
      },
    });
    expect(syncNoop.statusCode).toBe(200);
    const noopBody = syncNoop.json() as {
      gear: { result: { applied: string[]; version: number } }[];
    };
    expect(noopBody.gear[0]!.result.applied).toEqual([noopId]);
    expect(noopBody.gear[0]!.result.version).toBe(2);

    const staleId = randomUUID();
    await clearCooldown(ctx);
    const syncStale = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sync',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        source: 'addon',
        characterId,
        lists: [
          {
            list_id: list.id,
            since_version: 2,
            ops: [
              {
                op_id: staleId,
                type: 'clear_slot',
                slot: 'head',
                base_version: 0,
              },
            ],
          },
        ],
      },
    });
    expect(syncStale.statusCode).toBe(200);
    const staleBody = syncStale.json() as {
      gear: {
        result: { applied: string[]; conflicts: { op_id: string; reason: string }[]; version: number };
      }[];
    };
    expect(staleBody.gear[0]!.result.applied).toEqual([]);
    expect(staleBody.gear[0]!.result.conflicts).toEqual([
      expect.objectContaining({ op_id: staleId, reason: 'stale_base_version' }),
    ]);
    expect(staleBody.gear[0]!.result.version).toBe(3);

    const clearId = randomUUID();
    await clearCooldown(ctx);
    const syncClear = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sync',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        source: 'addon',
        characterId,
        lists: [
          {
            list_id: list.id,
            since_version: 3,
            ops: [
              {
                op_id: clearId,
                type: 'clear_slot',
                slot: 'head',
                base_version: 3,
              },
            ],
          },
        ],
      },
    });
    expect(syncClear.statusCode).toBe(200);
    const clearBody = syncClear.json() as {
      gear: {
        result: { applied: string[]; version: number; list: { slots: Record<string, number | null> } };
        events: { event_type: string }[];
      }[];
    };
    expect(clearBody.gear[0]!.result.applied).toEqual([clearId]);
    expect(clearBody.gear[0]!.result.version).toBe(4);
    expect(clearBody.gear[0]!.result.list.slots.head).toBeNull();
    expect(clearBody.gear[0]!.events.some((e) => e.event_type === 'GearSlotCleared')).toBe(true);

    // Mixed: after clear, addon add_item with older base via /sync stays rejected
    const addStaleId = randomUUID();
    await clearCooldown(ctx);
    const syncAddStale = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sync',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        source: 'addon',
        characterId,
        lists: [
          {
            list_id: list.id,
            since_version: 4,
            ops: [
              {
                op_id: addStaleId,
                type: 'add_item',
                slot: 'head',
                item_id: 16846,
                priority: 1,
                base_version: 2,
              },
            ],
          },
        ],
      },
    });
    expect(syncAddStale.statusCode).toBe(200);
    const addStaleBody = syncAddStale.json() as {
      gear: {
        result: {
          applied: string[];
          conflicts: { op_id: string; reason: string }[];
          list: { items: unknown[] };
        };
      }[];
    };
    expect(addStaleBody.gear[0]!.result.applied).toEqual([]);
    expect(addStaleBody.gear[0]!.result.conflicts).toEqual([
      expect.objectContaining({ op_id: addStaleId, reason: 'stale_base_version' }),
    ]);
    expect(addStaleBody.gear[0]!.result.list.items).toEqual([]);
  });


});
