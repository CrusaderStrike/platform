/**
 * Permanent gear-lists ops idempotency + version_conflict smoke (platform#62).
 * Locks the live set_slot/clear_slot contract from #46 and morning-path #26 into CI
 * against main (c014c43+). Ops never return HTTP 409 for stale base_version (OpenAPI:
 * "Item edits never return 409"); conflicts land in GearOpsResult.conflicts.
 * List meta If-Match still returns 409 version_mismatch with the retryable envelope.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestApp, signIn, shutdownEmbeddedPg, type TestCtx } from './helpers/setup.js';
import * as foreverItems from '../src/items/store.js';
import { GEAR_OP_NOOP_RETENTION_DAYS } from '../src/gear/noop-retention.js';

async function cool(ctx: TestCtx) {
  await ctx.app.clearGearWriteCooldowns?.();
}

async function selectDisplayed(ctx: TestCtx, cookie: string, csrf: string): Promise<string> {
  const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/me/characters', headers: { cookie } });
  const body = list.json() as {
    characters: { id: string; displayed: boolean }[];
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

async function seedCatalog(ctx: TestCtx) {
  for (const [itemId, name, slot, inv, armor, sub] of [
    [16846, "Giantstalker's Helmet", 'head', 'HEAD', 'mail', 3],
    [16900, 'Stormrage Cover', 'head', 'HEAD', 'leather', 2],
    [18813, 'Ring of Binding', 'finger1', 'FINGER', null, 0],
  ] as const) {
    await foreverItems.upsertItem(ctx.pool, {
      itemId,
      name,
      slot,
      slotAliases: slot === 'finger1' ? ['finger2'] : [],
      inventoryType: inv,
      quality: 'epic',
      itemLevel: 70,
      requiredLevel: 60,
      armorType: armor,
      itemClass: 4,
      itemSubclass: sub,
      stats: null,
      iconUrl: null,
      iconName: null,
      region: 'us',
    });
  }
  await foreverItems.setMeta(ctx.pool, { buildId: 'ops-idem-62', itemCount: 3, region: 'us' });
}

async function createList(
  ctx: TestCtx,
  cookie: string,
  csrf: string,
  characterId: string,
  name = 'OpsSmoke',
) {
  await cool(ctx);
  const created = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/characters/${characterId}/gear-lists`,
    headers: { cookie, 'x-csrf-token': csrf },
    payload: { name, type: 'max_level' },
  });
  expect(created.statusCode).toBe(201);
  return created.json() as {
    id: string;
    version: number;
    slots: Record<string, number | null>;
    items: { slot: string; item_id: number; priority: number }[];
  };
}

type OpsResult = {
  version: number;
  applied: string[];
  duplicates: string[];
  conflicts: { op_id: string; reason: string; message?: string; winning_version?: number }[];
  ignored?: { op_id: string; keys: string[] }[];
  list: {
    id: string;
    version: number;
    slots: Record<string, number | null>;
    items: { slot: string; item_id: number; priority: number }[];
  };
};

/** Assert GearOpsResult required keys from openapi/v1.yaml. */
function expectGearOpsResultShape(body: OpsResult) {
  expect(body).toEqual(
    expect.objectContaining({
      version: expect.any(Number),
      applied: expect.any(Array),
      duplicates: expect.any(Array),
      conflicts: expect.any(Array),
      list: expect.objectContaining({
        id: expect.any(String),
        version: expect.any(Number),
      }),
    }),
  );
}

describe('gear-lists ops idempotency + version_conflict (platform#62 / #46 / #26)', () => {
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
               gear_op_noop_ids, gear_list_events, gear_list_items, gear_lists, guild_members, guilds,
               forever_items, forever_items_meta, item_icon_cache, character_gear, character_selections, characters, sessions, oauth_states, users CASCADE
    `);
    await ctx.pool.query(
      `INSERT INTO forever_items_meta (id, build_id, item_count) VALUES (1, 'empty', 0) ON CONFLICT (id) DO NOTHING`,
    );
  });

  it('set_slot/clear_slot op_id dedupe: resend is noop, stable response, retention respected', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const h = { cookie, 'x-csrf-token': csrf };
    const characterId = await selectDisplayed(ctx, cookie, csrf);
    await seedCatalog(ctx);
    const list = await createList(ctx, cookie, csrf, characterId);

    await cool(ctx);
    const setId = randomUUID();
    const set1 = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: h,
      payload: {
        ops: [{ op_id: setId, type: 'set_slot', slot: 'head', item_id: 16846, base_version: list.version }],
      },
    });
    expect(set1.statusCode).toBe(200);
    const setBody = set1.json() as OpsResult;
    expectGearOpsResultShape(setBody);
    expect(setBody.applied).toEqual([setId]);
    expect(setBody.duplicates).toEqual([]);
    expect(setBody.conflicts).toEqual([]);
    expect(setBody.version).toBe(2);
    expect(setBody.list.slots.head).toBe(16846);

    // True no-op (same item already in slot) records op_id without version bump.
    await cool(ctx);
    const noopSetId = randomUUID();
    const noopSet = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: h,
      payload: {
        ops: [{ op_id: noopSetId, type: 'set_slot', slot: 'head', item_id: 16846, base_version: 2 }],
      },
    });
    expect(noopSet.statusCode).toBe(200);
    const noopBody = noopSet.json() as OpsResult;
    expectGearOpsResultShape(noopBody);
    expect(noopBody.applied).toEqual([noopSetId]);
    expect(noopBody.duplicates).toEqual([]);
    expect(noopBody.version).toBe(2);
    expect(noopBody.list.slots.head).toBe(16846);

    // Advance the slot so a later retry of noopSetId must not rewind it.
    await cool(ctx);
    const later = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: h,
      payload: {
        ops: [{ op_id: randomUUID(), type: 'set_slot', slot: 'head', item_id: 16900, base_version: 2 }],
      },
    });
    expect(later.statusCode).toBe(200);
    expect((later.json() as OpsResult).version).toBe(3);
    expect((later.json() as OpsResult).list.slots.head).toBe(16900);

    // Resend noopSetId → duplicates, no double-apply, slot stays 16900.
    await cool(ctx);
    const retrySet = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: h,
      payload: {
        ops: [{ op_id: noopSetId, type: 'set_slot', slot: 'head', item_id: 16846, base_version: 2 }],
      },
    });
    expect(retrySet.statusCode).toBe(200);
    const retrySetBody = retrySet.json() as OpsResult;
    expectGearOpsResultShape(retrySetBody);
    expect(retrySetBody.duplicates).toEqual([noopSetId]);
    expect(retrySetBody.applied).toEqual([]);
    expect(retrySetBody.conflicts).toEqual([]);
    expect(retrySetBody.version).toBe(3);
    expect(retrySetBody.list.slots.head).toBe(16900);

    // clear_slot path: apply, empty-noop, then duplicate after a later set.
    await cool(ctx);
    const clearId = randomUUID();
    const clear = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: h,
      payload: {
        ops: [{ op_id: clearId, type: 'clear_slot', slot: 'head', base_version: 3 }],
      },
    });
    expect(clear.statusCode).toBe(200);
    expect((clear.json() as OpsResult).version).toBe(4);
    expect((clear.json() as OpsResult).list.slots.head ?? null).toBeNull();

    await cool(ctx);
    const noopClearId = randomUUID();
    const noopClear = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: h,
      payload: {
        ops: [{ op_id: noopClearId, type: 'clear_slot', slot: 'head', base_version: 4 }],
      },
    });
    expect(noopClear.statusCode).toBe(200);
    const noopClearBody = noopClear.json() as OpsResult;
    expect(noopClearBody.applied).toEqual([noopClearId]);
    expect(noopClearBody.version).toBe(4);

    await cool(ctx);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: h,
      payload: {
        ops: [{ op_id: randomUUID(), type: 'set_slot', slot: 'head', item_id: 16846, base_version: 4 }],
      },
    });

    await cool(ctx);
    const retryClear = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: h,
      payload: {
        ops: [{ op_id: noopClearId, type: 'clear_slot', slot: 'head', base_version: 4 }],
      },
    });
    expect(retryClear.statusCode).toBe(200);
    const retryClearBody = retryClear.json() as OpsResult;
    expect(retryClearBody.duplicates).toEqual([noopClearId]);
    expect(retryClearBody.applied).toEqual([]);
    expect(retryClearBody.version).toBe(5);
    expect(retryClearBody.list.slots.head).toBe(16846);

    // In-window noop-id retention: marker still present for both noop op_ids.
    const keys = await ctx.pool.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM gear_op_noop_ids WHERE list_id = $1 ORDER BY idempotency_key`,
      [list.id],
    );
    const keySet = new Set(keys.rows.map((r) => r.idempotency_key));
    expect(keySet.has(`op:${noopSetId}`)).toBe(true);
    expect(keySet.has(`op:${noopClearId}`)).toBe(true);
    expect(GEAR_OP_NOOP_RETENTION_DAYS).toBeGreaterThan(0);
  });

  it('stale base_version: prior-request conflicts; same-batch applies; meta If-Match → 409 envelope', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const h = { cookie, 'x-csrf-token': csrf };
    const characterId = await selectDisplayed(ctx, cookie, csrf);
    await seedCatalog(ctx);
    const list = await createList(ctx, cookie, csrf, characterId);

    await cool(ctx);
    const first = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: h,
      payload: {
        ops: [{ op_id: randomUUID(), type: 'set_slot', slot: 'head', item_id: 16846, base_version: 1 }],
      },
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as OpsResult).version).toBe(2);

    // Prior-request stale set_slot → 200 with stale_base_version conflict (not HTTP 409).
    await cool(ctx);
    const staleId = randomUUID();
    const stale = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: h,
      payload: {
        ops: [{ op_id: staleId, type: 'set_slot', slot: 'head', item_id: 16900, base_version: 1 }],
      },
    });
    expect(stale.statusCode).toBe(200);
    const staleBody = stale.json() as OpsResult;
    expectGearOpsResultShape(staleBody);
    expect(staleBody.applied).toEqual([]);
    expect(staleBody.conflicts).toEqual([
      expect.objectContaining({ op_id: staleId, reason: 'stale_base_version' }),
    ]);
    expect(staleBody.list.slots.head).toBe(16846);
    // GearOpRejected is recorded (version may bump); slot contents must not change.
    expect(staleBody.version).toBeGreaterThanOrEqual(2);

    // Same-batch (#46): two set_slot/clear_slot-adjacent wishlist adds at one base_version all apply.
    await cool(ctx);
    const idA = randomUUID();
    const idB = randomUUID();
    const batch = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: h,
      payload: {
        ops: [
          {
            op_id: idA,
            type: 'add_item',
            slot: 'finger1',
            item_id: 18813,
            priority: 1,
            base_version: staleBody.version,
          },
          {
            op_id: idB,
            type: 'set_slot',
            slot: 'head',
            item_id: 16900,
            base_version: staleBody.version,
          },
        ],
      },
    });
    expect(batch.statusCode).toBe(200);
    const batchBody = batch.json() as OpsResult;
    expectGearOpsResultShape(batchBody);
    expect(batchBody.conflicts).toEqual([]);
    expect(batchBody.applied).toEqual(expect.arrayContaining([idA, idB]));
    expect(batchBody.list.slots.head).toBe(16900);
    expect(batchBody.list.items.some((i) => i.item_id === 18813)).toBe(true);

    // Meta If-Match path still returns 409 version_mismatch with retryable envelope + request_id.
    await cool(ctx);
    const meta = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/gear-lists/${list.id}`,
      headers: { ...h, 'if-match': '"v1"' },
      payload: { name: 'StaleRename', version: 1 },
    });
    expect(meta.statusCode).toBe(409);
    const metaBody = meta.json() as {
      error: { code: string; message: string; retryable: boolean; request_id: string };
      current: { version: number; list: { id: string } };
    };
    expect(metaBody.error.code).toBe('version_mismatch');
    expect(metaBody.error.retryable).toBe(true);
    expect(typeof metaBody.error.request_id).toBe('string');
    expect(metaBody.error.request_id.length).toBeGreaterThan(0);
    expect(metaBody.error.message).toMatch(/modified|reload|retry/i);
    expect(metaBody.current.list.id).toBe(list.id);
    expect(metaBody.current.version).toBeGreaterThan(1);
  });

  it('ignored keys, validation field-map, Forever rejects, foreign/deleted list, invalid_json', async () => {
    const { cookie, csrf } = await signIn(ctx);
    const h = { cookie, 'x-csrf-token': csrf };
    const characterId = await selectDisplayed(ctx, cookie, csrf);
    await seedCatalog(ctx);
    const list = await createList(ctx, cookie, csrf, characterId);

    // Soft-ignored unknown keys on an op.
    await cool(ctx);
    const ignId = randomUUID();
    const ignored = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: h,
      payload: {
        ops: [
          {
            op_id: ignId,
            type: 'set_slot',
            slot: 'head',
            item_id: 16846,
            base_version: list.version,
            client_extra: true,
            synced: false,
          },
        ],
      },
    });
    expect(ignored.statusCode).toBe(200);
    const ignBody = ignored.json() as OpsResult;
    expectGearOpsResultShape(ignBody);
    expect(ignBody.applied).toEqual([ignId]);
    expect(ignBody.ignored?.[0]).toMatchObject({ op_id: ignId });
    expect(ignBody.ignored?.[0]!.keys.sort()).toEqual(['client_extra', 'synced']);

    // Invalid slot → 400 validation field-map.
    await cool(ctx);
    const badSlot = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: h,
      payload: {
        ops: [
          {
            op_id: randomUUID(),
            type: 'set_slot',
            slot: 'not_a_slot',
            item_id: 16846,
            base_version: ignBody.version,
          },
        ],
      },
    });
    expect(badSlot.statusCode).toBe(400);
    const badSlotBody = badSlot.json() as { errors: Record<string, string> };
    expect(badSlotBody.errors).toEqual(expect.any(Object));
    expect(Object.keys(badSlotBody.errors).length).toBeGreaterThan(0);
    expect(JSON.stringify(badSlotBody.errors).toLowerCase()).toMatch(/slot|invalid|enum/);

    // Missing item_id on set_slot → validation field-map.
    await cool(ctx);
    const missingItem = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: h,
      payload: {
        ops: [{ op_id: randomUUID(), type: 'set_slot', slot: 'head', base_version: ignBody.version }],
      },
    });
    expect(missingItem.statusCode).toBe(400);
    const missingBody = missingItem.json() as { errors: Record<string, string> };
    expect(missingBody.errors).toEqual(expect.any(Object));
    expect(JSON.stringify(missingBody.errors)).toMatch(/item_id/);

    // Wrong-slot Forever item → conflicts item_not_in_slot (rejected path).
    await cool(ctx);
    const wrongId = randomUUID();
    const wrongSlot = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: h,
      payload: {
        ops: [
          {
            op_id: wrongId,
            type: 'set_slot',
            slot: 'head',
            item_id: 18813,
            base_version: ignBody.version,
          },
        ],
      },
    });
    expect(wrongSlot.statusCode).toBe(200);
    expect((wrongSlot.json() as OpsResult).conflicts).toEqual([
      expect.objectContaining({ op_id: wrongId, reason: 'item_not_in_slot' }),
    ]);

    // Non-Forever item → item_not_forever.
    await cool(ctx);
    const foreverId = randomUUID();
    const notForever = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: h,
      payload: {
        ops: [
          {
            op_id: foreverId,
            type: 'set_slot',
            slot: 'head',
            item_id: 999001,
            base_version: ignBody.version,
          },
        ],
      },
    });
    expect(notForever.statusCode).toBe(200);
    expect((notForever.json() as OpsResult).conflicts).toEqual([
      expect.objectContaining({ op_id: foreverId, reason: 'item_not_forever' }),
    ]);

    // Another user's list → 403 forbidden (same guild, ownership flipped).
    const otherUser = await ctx.pool.query<{ id: string }>(
      `INSERT INTO users (battlenet_id, battletag) VALUES ('bn-other-62', 'Other#62') RETURNING id`,
    );
    await ctx.pool.query(`UPDATE gear_lists SET owner_user_id = $1 WHERE id = $2`, [
      otherUser.rows[0]!.id,
      list.id,
    ]);
    await cool(ctx);
    const foreign = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: h,
      payload: {
        ops: [
          {
            op_id: randomUUID(),
            type: 'clear_slot',
            slot: 'head',
            base_version: ignBody.version,
          },
        ],
      },
    });
    expect([403, 404]).toContain(foreign.statusCode);
    const foreignBody = foreign.json() as { error: { code: string; request_id: string } };
    expect(['forbidden', 'not_found']).toContain(foreignBody.error.code);
    expect(typeof foreignBody.error.request_id).toBe('string');

    // Restore ownership, soft-delete, then ops → 404 not_found.
    await ctx.pool.query(
      `UPDATE gear_lists
         SET owner_user_id = (SELECT id FROM users WHERE battletag = 'Crusader#1234'),
             deleted_at = now()
       WHERE id = $1`,
      [list.id],
    );

    await cool(ctx);
    const onDeleted = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${list.id}/ops`,
      headers: h,
      payload: {
        ops: [
          {
            op_id: randomUUID(),
            type: 'clear_slot',
            slot: 'head',
            base_version: ignBody.version,
          },
        ],
      },
    });
    expect(onDeleted.statusCode).toBe(404);
    expect((onDeleted.json() as { error: { code: string } }).error.code).toBe('not_found');

    // Malformed JSON → invalid_json field-map (+ human message).
    const badJson = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/gear-lists/${randomUUID()}/ops`,
      headers: { ...h, 'content-type': 'application/json' },
      payload: '{"ops":[',
    });
    expect(badJson.statusCode).toBe(400);
    const badJsonBody = badJson.json() as { errors: { body: string }; message?: string };
    expect(badJsonBody.errors).toEqual({ body: 'invalid_json' });
    expect(typeof badJsonBody.message).toBe('string');
    expect(badJsonBody.message).not.toMatch(/SyntaxError|Unexpected|position/);
  });
});
