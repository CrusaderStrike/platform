import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, signIn, type TestCtx } from './helpers/setup.js';

async function pickSelectedCharacter(ctx: TestCtx, cookie: string, csrf: string) {
  const chars = (
    await ctx.app.inject({ method: 'GET', url: '/api/v1/me/characters', headers: { cookie } })
  ).json() as { characters: Array<{ id: string }>; selection: { main_id: string } | null };
  const mainId = chars.characters[0]!.id;
  if (!chars.selection) {
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/me/characters/selection',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: { main_id: mainId, alt_ids: [] },
    });
  }
  return chars.selection?.main_id ?? mainId;
}

function sampleRun(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    gameVersion: 'forever',
    idempotencyKey: 'Emberfall|Lightbringer|1730000000|36',
    addonRunId: 'Emberfall|Lightbringer|1730000000|36',
    realm: 'Emberfall',
    character: 'Lightbringer',
    instance: { id: 36, name: 'The Deadmines', difficulty: 1, difficultyName: 'Normal' },
    startedAt: 1730000000,
    endedAt: 1730001800,
    durationSec: 1800,
    completed: true,
    status: 'completed',
    party: [{ name: 'Lightbringer', realm: 'Emberfall', class: 'PALADIN', level: 60, isPlayer: true }],
    bosses: [{ npcId: 639, name: "Edwin VanCleef", killedAt: 1730001700 }],
    deaths: [],
    ...overrides,
  };
}

function sampleWorld(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    addon_pvp_id: 'Emberfall|Lightbringer|W|1730000000|kill|1',
    time: 1730000000,
    zone: 'Elwynn Forest',
    subzone: null,
    result: 'kill',
    honorable: true,
    killer_source: null,
    opponent: { name: 'Enemy', realm: 'Emberfall', class: 'WARRIOR', level: 60, faction: 'horde' },
    ...overrides,
  };
}

function sampleBg(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    addon_pvp_id: 'Emberfall|Lightbringer|BG|1730000000|489',
    mapId: 489,
    mapName: 'Warsong Gulch',
    faction: 'alliance',
    startedAt: 1730000000,
    endedAt: 1730000900,
    durationSec: 900,
    result: 'win',
    winner: 1,
    stats: { honorableKills: 12, deaths: 3, honor: 150 },
    ...overrides,
  };
}

describe('POST /api/v1/uploads (platform#3)', () => {
  let ctx: TestCtx;

  afterEach(async () => {
    if (ctx) {
      await ctx.app.clearUploadCooldowns?.();
      await ctx.stop();
    }
  });

  it('401 without session', async () => {
    ctx = await startTestApp();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'x' },
      payload: { schemaVersion: 1, characterId: 'x', dungeonRuns: [sampleRun()] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts dungeon + world PvP + BG; dedupes on second upload', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await pickSelectedCharacter(ctx, cookie, csrf);

    const payload = {
      schemaVersion: 1,
      characterId,
      dungeonRuns: [sampleRun()],
      worldPvp: [sampleWorld()],
      battlegrounds: [sampleBg()],
    };
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ accepted: 3, duplicate: 0, rejected: [] });

    await ctx.app.clearUploadCooldowns?.();
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ accepted: 0, duplicate: 3, rejected: [] });

    const runs = await ctx.pool.query(`SELECT dungeon_id, completed, status FROM dungeon_runs`);
    expect(runs.rowCount).toBe(1);
    expect(runs.rows[0]).toMatchObject({ dungeon_id: 36, completed: true, status: 'completed' });

    const world = await ctx.pool.query(`SELECT result, honorable FROM pvp_world_events`);
    expect(world.rowCount).toBe(1);
    expect(world.rows[0]).toMatchObject({ result: 'kill', honorable: true });

    const bg = await ctx.pool.query<{ stats: { honorable_kills: number; killing_blows?: unknown } }>(
      `SELECT stats FROM pvp_battlegrounds`,
    );
    expect(bg.rowCount).toBe(1);
    expect(bg.rows[0]!.stats.honorable_kills).toBe(12);
    expect(bg.rows[0]!.stats).not.toHaveProperty('killing_blows');
    expect(bg.rows[0]!.stats).not.toHaveProperty('killingBlows');
  });

  it('rejects unknown schema version', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await pickSelectedCharacter(ctx, cookie, csrf);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: { schemaVersion: 99, characterId, dungeonRuns: [sampleRun()] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errors: { schemaVersion: expect.stringContaining('unsupported') } });
  });

  it('rejects extra properties (strict)', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await pickSelectedCharacter(ctx, cookie, csrf);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        characterId,
        dungeonRuns: [sampleRun()],
        unexpected: true,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toMatch(/unexpected|Unrecognized|additional/i);
  });

  it('rejects killingBlows in BG stats', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await pickSelectedCharacter(ctx, cookie, csrf);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        characterId,
        battlegrounds: [
          sampleBg({ stats: { honorableKills: 1, killingBlows: 5, deaths: 0, honor: 10 } }),
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('403 when characterId is not in selection', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    await pickSelectedCharacter(ctx, cookie, csrf);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        characterId: 'ch_us_not_selected',
        dungeonRuns: [sampleRun()],
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rate-limits consecutive uploads', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await pickSelectedCharacter(ctx, cookie, csrf);
    const payload = {
      schemaVersion: 1,
      characterId,
      dungeonRuns: [sampleRun({ addonRunId: 'a|b|1|36', idempotencyKey: 'a|b|1|36' })],
    };
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload,
    });
    expect(first.statusCode).toBe(200);
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: {
        ...payload,
        dungeonRuns: [sampleRun({ addonRunId: 'a|b|2|36', idempotencyKey: 'a|b|2|36' })],
      },
    });
    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBeTruthy();
  });

  it('rejects gameVersion other than forever on a run', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const characterId = await pickSelectedCharacter(ctx, cookie, csrf);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        characterId,
        dungeonRuns: [sampleRun({ gameVersion: 'classic' })],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
