import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, signIn, type TestCtx } from './helpers/setup.js';

const here = path.dirname(fileURLToPath(import.meta.url));

type CharInfo = { id: string; character_name: string; realm: string };

async function pickSelectedCharacter(ctx: TestCtx, cookie: string, csrf: string): Promise<CharInfo> {
  const chars = (
    await ctx.app.inject({ method: 'GET', url: '/api/v1/me/characters', headers: { cookie } })
  ).json() as {
    characters: Array<{ id: string; character_name: string; realm: string | null }>;
    selection: { main_id: string } | null;
  };
  const light = chars.characters.find((c) => c.character_name === 'Lightbringer' && c.realm);
  const chosen = light ?? chars.characters.find((c) => c.realm) ?? chars.characters[0]!;
  if (!chosen.realm) throw new Error('need a character with realm for upload tests');
  if (!chars.selection || chars.selection.main_id !== chosen.id) {
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/me/characters/selection',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: { main_id: chosen.id, alt_ids: [] },
    });
  }
  return { id: chosen.id, character_name: chosen.character_name, realm: chosen.realm };
}

function sampleRun(ch: CharInfo, overrides: Record<string, unknown> = {}) {
  const addonRunId =
    (overrides.addonRunId as string | undefined) ??
    `${ch.realm}|${ch.character_name}|1730000000|36`;
  return {
    schemaVersion: 1,
    gameVersion: 'forever',
    idempotencyKey: addonRunId,
    addonRunId,
    realm: ch.realm,
    character: ch.character_name,
    instance: { id: 36, name: 'The Deadmines', difficulty: 1, difficultyName: 'Normal' },
    startedAt: 1730000000,
    endedAt: 1730001800,
    durationSec: 1800,
    completed: true,
    status: 'completed',
    party: [
      { name: ch.character_name, realm: ch.realm, class: 'PALADIN', level: 60, isPlayer: true },
    ],
    bosses: [{ npcId: 639, name: 'Edwin VanCleef', killedAt: 1730001700 }],
    deaths: [],
    ...overrides,
    // Keep id/key aligned unless caller overrode both intentionally.
    ...(overrides.addonRunId && !overrides.idempotencyKey
      ? { idempotencyKey: overrides.addonRunId }
      : {}),
  };
}

function sampleWorld(ch: CharInfo, overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    addon_pvp_id: `${ch.realm}|${ch.character_name}|W|1730000000|kill|1`,
    time: 1730000000,
    zone: 'Elwynn Forest',
    subzone: null,
    result: 'kill',
    honorable: true,
    killer_source: null,
    opponent: { name: 'Enemy', realm: ch.realm, class: 'WARRIOR', level: 60, faction: 'horde' },
    ...overrides,
  };
}

function sampleBg(ch: CharInfo, overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    addon_pvp_id: `${ch.realm}|${ch.character_name}|BG|1730000000|489`,
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
      payload: {
        schemaVersion: 1,
        characterId: 'x',
        dungeonRuns: [sampleRun({ id: 'x', character_name: 'x', realm: 'x' })],
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts dungeon + world PvP + BG; dedupes on second upload', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const ch = await pickSelectedCharacter(ctx, cookie, csrf);

    const payload = {
      schemaVersion: 1,
      characterId: ch.id,
      dungeonRuns: [sampleRun(ch)],
      worldPvp: [sampleWorld(ch)],
      battlegrounds: [sampleBg(ch)],
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

    const bg = await ctx.pool.query<{ stats: { honorable_kills: number } }>(
      `SELECT stats FROM pvp_battlegrounds`,
    );
    expect(bg.rowCount).toBe(1);
    expect(bg.rows[0]!.stats.honorable_kills).toBe(12);
    expect(bg.rows[0]!.stats).not.toHaveProperty('killing_blows');
    expect(bg.rows[0]!.stats).not.toHaveProperty('killingBlows');
  });

  it('soft-ignores synced and killingBlows; stores stripped raw_payload', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const ch = await pickSelectedCharacter(ctx, cookie, csrf);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        characterId: ch.id,
        worldPvp: [sampleWorld(ch, { synced: true })],
        battlegrounds: [
          sampleBg(ch, {
            synced: false,
            stats: { honorableKills: 1, killingBlows: 5, deaths: 0, honor: 10 },
          }),
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      accepted: number;
      ignored: Array<{ kind: string; keys: string[] }>;
    };
    expect(body.accepted).toBe(2);
    expect(body.ignored.some((i) => i.kind === 'world_pvp' && i.keys.includes('synced'))).toBe(true);
    expect(
      body.ignored.some((i) => i.kind === 'battleground' && i.keys.includes('stats.killingBlows')),
    ).toBe(true);

    const world = await ctx.pool.query<{ raw_payload: Record<string, unknown> }>(
      `SELECT raw_payload FROM pvp_world_events`,
    );
    expect(world.rows[0]!.raw_payload).not.toHaveProperty('synced');

    const bg = await ctx.pool.query<{
      raw_payload: { stats?: Record<string, unknown> };
      stats: Record<string, unknown>;
    }>(`SELECT raw_payload, stats FROM pvp_battlegrounds`);
    expect(bg.rows[0]!.raw_payload).not.toHaveProperty('synced');
    expect(bg.rows[0]!.raw_payload.stats).not.toHaveProperty('killingBlows');
    expect(bg.rows[0]!.stats).not.toHaveProperty('killingBlows');
    expect(bg.rows[0]!.stats.honorable_kills).toBe(1);
  });

  it('upgrades in_progress to completed (forward-only); never regresses', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const ch = await pickSelectedCharacter(ctx, cookie, csrf);
    const runId = `${ch.realm}|${ch.character_name}|1730001111|36`;

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        characterId: ch.id,
        dungeonRuns: [
          sampleRun(ch, {
            addonRunId: runId,
            idempotencyKey: runId,
            completed: false,
            status: 'in_progress',
            endedAt: null,
            durationSec: null,
            bosses: [],
          }),
        ],
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ accepted: 1, duplicate: 0 });

    await ctx.app.clearUploadCooldowns?.();
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        characterId: ch.id,
        dungeonRuns: [
          sampleRun(ch, {
            addonRunId: runId,
            idempotencyKey: runId,
            completed: true,
            status: 'completed',
          }),
        ],
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ accepted: 1, duplicate: 0 });

    const mid = await ctx.pool.query(`SELECT status, completed FROM dungeon_runs WHERE addon_run_id = $1`, [
      runId,
    ]);
    expect(mid.rowCount).toBe(1);
    expect(mid.rows[0]).toMatchObject({ status: 'completed', completed: true });

    await ctx.app.clearUploadCooldowns?.();
    const third = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        characterId: ch.id,
        dungeonRuns: [
          sampleRun(ch, {
            addonRunId: runId,
            idempotencyKey: runId,
            completed: false,
            status: 'in_progress',
            endedAt: null,
          }),
        ],
      },
    });
    expect(third.statusCode).toBe(200);
    expect(third.json()).toMatchObject({ accepted: 0, duplicate: 1 });

    const final = await ctx.pool.query(`SELECT status, completed FROM dungeon_runs WHERE addon_run_id = $1`, [
      runId,
    ]);
    expect(final.rows[0]).toMatchObject({ status: 'completed', completed: true });
  });

  it('dedupes across guild switch on character_id + addon id', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const ch = await pickSelectedCharacter(ctx, cookie, csrf);

    const payload = {
      schemaVersion: 1,
      characterId: ch.id,
      dungeonRuns: [sampleRun(ch)],
      worldPvp: [sampleWorld(ch)],
      battlegrounds: [sampleBg(ch)],
    };
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ accepted: 3 });
    const userRow = await ctx.pool.query<{ user_id: string }>(`SELECT user_id FROM sessions LIMIT 1`);
    const userId = userRow.rows[0]!.user_id;
    const g2 = await ctx.pool.query<{ id: string }>(
      `INSERT INTO guilds (name, kind, owner_user_id) VALUES ('Other', 'guild', $1) RETURNING id`,
      [userId],
    );
    const guild2 = g2.rows[0]!.id;
    await ctx.pool.query(`INSERT INTO guild_members (guild_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      guild2,
      userId,
    ]);
    await ctx.pool.query(`UPDATE sessions SET active_guild_id = $1`, [guild2]);

    await ctx.app.clearUploadCooldowns?.();
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ accepted: 0, duplicate: 3 });

    expect((await ctx.pool.query(`SELECT id FROM dungeon_runs`)).rowCount).toBe(1);
    expect((await ctx.pool.query(`SELECT id FROM pvp_world_events`)).rowCount).toBe(1);
    expect((await ctx.pool.query(`SELECT id FROM pvp_battlegrounds`)).rowCount).toBe(1);

    const runGuild = await ctx.pool.query<{ guild_id: string }>(`SELECT guild_id FROM dungeon_runs`);
    expect(runGuild.rows[0]!.guild_id).toBe(guild2);
    const worldGuild = await ctx.pool.query<{ guild_id: string }>(`SELECT guild_id FROM pvp_world_events`);
    expect(worldGuild.rows[0]!.guild_id).toBe(guild2);
    const bgGuild = await ctx.pool.query<{ guild_id: string }>(`SELECT guild_id FROM pvp_battlegrounds`);
    expect(bgGuild.rows[0]!.guild_id).toBe(guild2);
  });

  it('rejects per-record character mismatch', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const ch = await pickSelectedCharacter(ctx, cookie, csrf);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        characterId: ch.id,
        dungeonRuns: [
          sampleRun(ch, {
            realm: 'OtherRealm',
            character: 'SomeoneElse',
            addonRunId: 'OtherRealm|SomeoneElse|1|36',
            idempotencyKey: 'OtherRealm|SomeoneElse|1|36',
          }),
        ],
        worldPvp: [sampleWorld(ch, { addon_pvp_id: 'Wrong|Name|W|1|kill|1' })],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { accepted: number; rejected: Array<{ reason: string }> };
    expect(body.accepted).toBe(0);
    expect(body.rejected).toHaveLength(2);
    expect(body.rejected.every((r) => r.reason === 'character_mismatch')).toBe(true);
  });

  it('accepts realm+name envelope instead of characterId', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const ch = await pickSelectedCharacter(ctx, cookie, csrf);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        realm: ch.realm,
        name: ch.character_name,
        dungeonRuns: [
          sampleRun(ch, {
            addonRunId: `${ch.realm}|${ch.character_name}|1730002222|36`,
            idempotencyKey: `${ch.realm}|${ch.character_name}|1730002222|36`,
          }),
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accepted: 1, duplicate: 0 });
  });

  it('rejects unknown schema version', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const ch = await pickSelectedCharacter(ctx, cookie, csrf);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: { schemaVersion: 99, characterId: ch.id, dungeonRuns: [sampleRun(ch)] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errors: { schemaVersion: expect.stringContaining('unsupported') },
    });
  });

  it('rejects extra properties on envelope (strict)', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const ch = await pickSelectedCharacter(ctx, cookie, csrf);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        characterId: ch.id,
        dungeonRuns: [sampleRun(ch)],
        unexpected: true,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toMatch(/unexpected|Unrecognized|additional/i);
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
        dungeonRuns: [sampleRun({ id: 'x', character_name: 'Lightbringer', realm: 'Emberfall' })],
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rate-limits consecutive successful uploads; validation errors do not burn cooldown', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const ch = await pickSelectedCharacter(ctx, cookie, csrf);

    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        characterId: ch.id,
        dungeonRuns: [sampleRun(ch, { gameVersion: 'classic' })],
      },
    });
    expect(bad.statusCode).toBe(400);

    const okPayload = {
      schemaVersion: 1,
      characterId: ch.id,
      dungeonRuns: [
        sampleRun(ch, {
          addonRunId: `${ch.realm}|${ch.character_name}|1|36`,
          idempotencyKey: `${ch.realm}|${ch.character_name}|1|36`,
        }),
      ],
    };
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: okPayload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ accepted: 1 });

    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: {
        ...okPayload,
        dungeonRuns: [
          sampleRun(ch, {
            addonRunId: `${ch.realm}|${ch.character_name}|2|36`,
            idempotencyKey: `${ch.realm}|${ch.character_name}|2|36`,
          }),
        ],
      },
    });
    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBeTruthy();
  });

  it('rejects gameVersion other than forever on a run', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const ch = await pickSelectedCharacter(ctx, cookie, csrf);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        characterId: ch.id,
        dungeonRuns: [sampleRun(ch, { gameVersion: 'classic' })],
      },
    });
    expect(res.statusCode).toBe(400);
  });


  it('normalizes multi-word / hyphenated / apostrophe realms on per-record match', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const ch = await pickSelectedCharacter(ctx, cookie, csrf);

    const cases: Array<{ stored: string; addon: string; label: string }> = [
      { stored: 'Pyrewood Village', addon: 'PyrewoodVillage', label: 'multi-word' },
      { stored: 'Azjol-Nerub', addon: 'AzjolNerub', label: 'hyphenated' },
      { stored: "Kel'Thuzad", addon: 'KelThuzad', label: 'apostrophe' },
    ];

    for (const [i, c] of cases.entries()) {
      await ctx.pool.query(`UPDATE characters SET realm = $1 WHERE id = $2`, [c.stored, ch.id]);
      await ctx.app.clearUploadCooldowns?.();
      const runId = `${c.addon}|${ch.character_name}|1730100${i}|36`;
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/uploads',
        headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
        payload: {
          schemaVersion: 1,
          characterId: ch.id,
          dungeonRuns: [
            sampleRun(
              { ...ch, realm: c.addon },
              {
                addonRunId: runId,
                idempotencyKey: runId,
                realm: c.addon,
                character: ch.character_name,
              },
            ),
          ],
          worldPvp: [
            sampleWorld(
              { ...ch, realm: c.addon },
              { addon_pvp_id: `${c.addon}|${ch.character_name}|W|1730100${i}|kill|1` },
            ),
          ],
        },
      });
      expect(res.statusCode, c.label).toBe(200);
      const body = res.json() as { accepted: number; rejected: unknown[] };
      expect(body.accepted, c.label).toBe(2);
      expect(body.rejected, c.label).toEqual([]);
    }
  });

  it('normalizes realms on realm+name envelope lookup', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const ch = await pickSelectedCharacter(ctx, cookie, csrf);

    const cases: Array<{ stored: string; addon: string; label: string }> = [
      { stored: 'Pyrewood Village', addon: 'PyrewoodVillage', label: 'multi-word' },
      { stored: 'Azjol-Nerub', addon: 'AzjolNerub', label: 'hyphenated' },
      { stored: "Kel'Thuzad", addon: 'KelThuzad', label: 'apostrophe' },
    ];

    for (const [i, c] of cases.entries()) {
      await ctx.pool.query(`UPDATE characters SET realm = $1 WHERE id = $2`, [c.stored, ch.id]);
      await ctx.app.clearUploadCooldowns?.();
      const runId = `${c.addon}|${ch.character_name}|1730200${i}|36`;
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/uploads',
        headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
        payload: {
          schemaVersion: 1,
          realm: c.addon,
          name: ch.character_name,
          dungeonRuns: [
            sampleRun(
              { ...ch, realm: c.addon },
              {
                addonRunId: runId,
                idempotencyKey: runId,
                realm: c.addon,
                character: ch.character_name,
              },
            ),
          ],
        },
      });
      expect(res.statusCode, c.label).toBe(200);
      expect(res.json(), c.label).toMatchObject({ accepted: 1, character_id: ch.id });
    }
  });

  it('refreshes still-in_progress run data (more bosses/deaths) without status regression', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const ch = await pickSelectedCharacter(ctx, cookie, csrf);
    const runId = `${ch.realm}|${ch.character_name}|1730300000|36`;

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        characterId: ch.id,
        dungeonRuns: [
          sampleRun(ch, {
            addonRunId: runId,
            idempotencyKey: runId,
            completed: false,
            status: 'in_progress',
            endedAt: null,
            durationSec: null,
            bosses: [{ npcId: 1, name: 'Boss A', killedAt: 1730300100 }],
            deaths: [],
          }),
        ],
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ accepted: 1 });

    await ctx.app.clearUploadCooldowns?.();
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: {
        schemaVersion: 1,
        characterId: ch.id,
        dungeonRuns: [
          sampleRun(ch, {
            addonRunId: runId,
            idempotencyKey: runId,
            completed: false,
            status: 'in_progress',
            endedAt: null,
            durationSec: null,
            bosses: [
              { npcId: 1, name: 'Boss A', killedAt: 1730300100 },
              { npcId: 2, name: 'Boss B', killedAt: 1730300500 },
            ],
            deaths: [{ name: ch.character_name, realm: ch.realm, time: 1730300400, source: 'trap' }],
          }),
        ],
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ accepted: 1, duplicate: 0 });

    const row = await ctx.pool.query<{
      status: string;
      bosses: unknown[];
      deaths: unknown[];
    }>(`SELECT status, bosses, deaths FROM dungeon_runs WHERE addon_run_id = $1`, [runId]);
    expect(row.rows[0]!.status).toBe('in_progress');
    expect(row.rows[0]!.bosses).toHaveLength(2);
    expect(row.rows[0]!.deaths).toHaveLength(1);
  });

  it('uses SAVEPOINT so one DB error does not poison later records or fake accepted', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const ch = await pickSelectedCharacter(ctx, cookie, csrf);

    // First record: invalid FK guild via broken client would be hard; instead force a
    // constraint failure with an oversized dungeon_name after temporarily shortening the column.
    // Safer approach: pass a character_id that doesn't exist by monkey-patching via SQL
    // — insert a run that will succeed, then a world PvP with a deliberately invalid
    // result enum that zod would reject. For DB-level: use an invalid character_id FK
    // by uploading after deleting RLS path... Use raw SQL to create a check that fails:
    // temporarily drop FK isn't available. Use a too-long zone by bypassing zod?
    // Simplest reliable path: spy via injecting a second record that hits UNIQUE on
    // a forced partial insert failure — use invalid UUID for character by calling store
    // through a poisoned character_id. We'll UPDATE the characters table mid-batch is hard.
    //
    // Practical approach used here: first dungeon run is fine; second dungeon run uses the
    // same addon_run_id with a payload that would normally duplicate — that isn't an error.
    // Instead, force insert_failed by using a world PvP with addon_pvp_id that exceeds
    // the column length after temporarily altering... columns are text.
    //
    // Use a non-existent character_id FK: replace owned character's id temporarily? No.
    // Call the route with a crafted battleground where mapId overflows INTEGER — zod
    // already caps numbers.
    //
    // Use pool.query to install a trigger that fails on first pvp_world_events insert:
    await ctx.pool.query(`
      CREATE OR REPLACE FUNCTION test_fail_first_world_pvp() RETURNS trigger AS $$
      BEGIN
        IF NEW.zone = 'FAIL_ZONE' THEN
          RAISE EXCEPTION 'forced test failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS test_fail_world_pvp ON pvp_world_events;
      CREATE TRIGGER test_fail_world_pvp
        BEFORE INSERT ON pvp_world_events
        FOR EACH ROW EXECUTE FUNCTION test_fail_first_world_pvp();
    `);

    try {
      const goodRunId = `${ch.realm}|${ch.character_name}|1730400001|36`;
      const goodWorldId = `${ch.realm}|${ch.character_name}|W|1730400002|kill|1`;
      const badWorldId = `${ch.realm}|${ch.character_name}|W|1730400003|kill|1`;
      const laterRunId = `${ch.realm}|${ch.character_name}|1730400004|36`;

      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/uploads',
        headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
        payload: {
          schemaVersion: 1,
          characterId: ch.id,
          dungeonRuns: [
            sampleRun(ch, { addonRunId: goodRunId, idempotencyKey: goodRunId }),
            sampleRun(ch, {
              addonRunId: laterRunId,
              idempotencyKey: laterRunId,
              startedAt: 1730400004,
            }),
          ],
          worldPvp: [
            sampleWorld(ch, { addon_pvp_id: badWorldId, zone: 'FAIL_ZONE', time: 1730400003 }),
            sampleWorld(ch, { addon_pvp_id: goodWorldId, zone: 'Elwynn Forest', time: 1730400002 }),
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        accepted: number;
        duplicate: number;
        rejected: Array<{ kind: string; id: string; reason: string }>;
      };
      expect(body.rejected).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'world_pvp',
            id: badWorldId,
            reason: 'insert_failed',
          }),
        ]),
      );
      expect(body.rejected).toHaveLength(1);
      // Two dungeon runs + one good world PvP
      expect(body.accepted).toBe(3);
      expect(body.duplicate).toBe(0);

      expect((await ctx.pool.query(`SELECT id FROM dungeon_runs`)).rowCount).toBe(2);
      expect((await ctx.pool.query(`SELECT id FROM pvp_world_events`)).rowCount).toBe(1);
      const zones = await ctx.pool.query<{ zone: string }>(`SELECT zone FROM pvp_world_events`);
      expect(zones.rows[0]!.zone).toBe('Elwynn Forest');
    } finally {
      await ctx.pool.query(`
        DROP TRIGGER IF EXISTS test_fail_world_pvp ON pvp_world_events;
        DROP FUNCTION IF EXISTS test_fail_first_world_pvp();
      `);
    }
  });

  it('accepts a realistic addon export fixture with synced and killingBlows', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const ch = await pickSelectedCharacter(ctx, cookie, csrf);
    const fixture = JSON.parse(
      readFileSync(path.join(here, 'fixtures/realistic-addon-export.json'), 'utf8'),
    ) as Record<string, unknown>;
    fixture.characterId = ch.id;
    // Rewrite realm/name in fixture records to the selected character.
    const runs = fixture.dungeonRuns as Array<Record<string, unknown>>;
    for (const r of runs) {
      r.realm = ch.realm;
      r.character = ch.character_name;
      const id = `${ch.realm}|${ch.character_name}|1730000000|36`;
      r.addonRunId = id;
      r.idempotencyKey = id;
    }
    const world = fixture.worldPvp as Array<Record<string, unknown>>;
    for (const r of world) {
      r.addon_pvp_id = `${ch.realm}|${ch.character_name}|W|1730000000|kill|1`;
    }
    const bgs = fixture.battlegrounds as Array<Record<string, unknown>>;
    for (const r of bgs) {
      r.addon_pvp_id = `${ch.realm}|${ch.character_name}|BG|1730000000|489`;
    }

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: fixture,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      accepted: number;
      rejected: unknown[];
      ignored: Array<{ keys: string[] }>;
    };
    expect(body.accepted).toBe(3);
    expect(body.rejected).toEqual([]);
    const allKeys = body.ignored.flatMap((i) => i.keys);
    expect(allKeys).toEqual(expect.arrayContaining(['synced', 'stats.killingBlows']));

    const party = await ctx.pool.query<{ party: Array<{ level: number | null }> }>(
      `SELECT party FROM dungeon_runs`,
    );
    expect(party.rows[0]!.party.some((p) => p.level === null || p.level === undefined)).toBe(true);
  });
});
