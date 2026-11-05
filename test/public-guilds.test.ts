import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp, shutdownEmbeddedPg, type TestCtx } from './helpers/setup.js';

async function seedPublicGuild(
  ctx: TestCtx,
  opts: {
    name: string;
    region?: 'us' | 'eu' | 'kr' | 'tw';
    realm_slug: string;
    realm_name: string;
    guild_slug: string;
    faction: 'alliance' | 'horde';
    recruiting?: boolean;
    public_listed?: boolean;
    open_roles?: string[];
    recruiting_needs?: unknown;
    pitch?: string;
    raid_timezone?: string;
    public_member_count?: number;
    updated_at?: string;
  },
) {
  const res = await ctx.pool.query<{ id: string }>(
    `INSERT INTO guilds (
       name, kind, region, realm_slug, realm_name, guild_slug, faction,
       pitch, recruiting, public_listed, open_roles, recruiting_needs,
       raid_schedule, raid_timezone, contact, public_member_count, updated_at
     ) VALUES (
       $1, 'guild', $2, $3, $4, $5, $6,
       $7, $8, $9, $10::text[], $11::jsonb,
       $12::jsonb, $13, $14::jsonb, $15, COALESCE($16::timestamptz, now())
     ) RETURNING id`,
    [
      opts.name,
      opts.region ?? 'us',
      opts.realm_slug,
      opts.realm_name,
      opts.guild_slug,
      opts.faction,
      opts.pitch ?? 'Looking for raiders.',
      opts.recruiting ?? true,
      opts.public_listed ?? true,
      opts.open_roles ?? ['tank', 'dps'],
      JSON.stringify(
        opts.recruiting_needs ?? [{ class: 'warrior', role: 'tank', priority: 'high' }],
      ),
      JSON.stringify([{ day: 'tue', start: '20:00', end: '23:00' }]),
      opts.raid_timezone ?? 'America/Los_Angeles',
      JSON.stringify({ type: 'discord', value: 'https://discord.gg/crusader' }),
      opts.public_member_count ?? 42,
      opts.updated_at ?? null,
    ],
  );
  return res.rows[0]!.id;
}

describe('public guilds API (platform#37)', () => {
  let ctx: TestCtx;

  beforeAll(async () => {
    ctx = await startTestApp();
  }, 120_000);

  afterAll(async () => {
    await ctx.stop();
    await shutdownEmbeddedPg();
  });

  beforeEach(async () => {
    await ctx.pool.query(`
      TRUNCATE public_api_rate_limits, upload_rate_limits, gear_write_rate_limits, pvp_battlegrounds, pvp_world_events, dungeon_runs,
               gear_list_events, gear_list_items, gear_lists, guild_members, guilds,
               item_icon_cache, character_gear, character_selections, characters, sessions, oauth_states, users CASCADE
    `);
  });

  it('lists only public_listed guilds with region + cache headers', async () => {
    await seedPublicGuild(ctx, {
      name: 'Crusaders',
      realm_slug: 'emberfall',
      realm_name: 'Emberfall',
      guild_slug: 'crusaders',
      faction: 'alliance',
    });
    await seedPublicGuild(ctx, {
      name: 'Hidden',
      realm_slug: 'emberfall',
      realm_name: 'Emberfall',
      guild_slug: 'hidden',
      faction: 'horde',
      public_listed: false,
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/public/guilds' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.headers.etag).toBeTruthy();
    expect(res.headers['ratelimit-limit']).toBeTruthy();
    const body = res.json() as {
      items: { region: string; guild_slug: string }[];
      next_cursor: string | null;
    };
    expect(body.items).toEqual([
      expect.objectContaining({ region: 'us', guild_slug: 'crusaders' }),
    ]);
    expect(body.next_cursor).toBeNull();
  });

  it('filters by region (repeatable OR), realm, faction, role, class', async () => {
    await seedPublicGuild(ctx, {
      name: 'A',
      region: 'us',
      realm_slug: 'emberfall',
      realm_name: 'Emberfall',
      guild_slug: 'alpha',
      faction: 'alliance',
      open_roles: ['tank'],
      recruiting_needs: [{ class: 'warrior', role: 'tank', priority: 'high' }],
    });
    await seedPublicGuild(ctx, {
      name: 'B',
      region: 'eu',
      realm_slug: 'normal',
      realm_name: 'Normal',
      guild_slug: 'bravo',
      faction: 'horde',
      open_roles: ['healer'],
      recruiting_needs: [{ class: 'priest', role: 'healer', priority: 'medium' }],
    });
    await seedPublicGuild(ctx, {
      name: 'C',
      region: 'kr',
      realm_slug: 'pvp',
      realm_name: 'PvP',
      guild_slug: 'charlie',
      faction: 'alliance',
      open_roles: ['dps'],
      recruiting_needs: [{ class: 'mage', role: 'dps', priority: 'low' }],
    });

    const byRegions = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/public/guilds?region=us&region=eu',
    });
    expect(byRegions.statusCode).toBe(200);
    const regions = (byRegions.json().items as { region: string }[]).map((i) => i.region).sort();
    expect(regions).toEqual(['eu', 'us']);

    const badRegion = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/public/guilds?region=na',
    });
    expect(badRegion.statusCode).toBe(400);

    const byRealm = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/public/guilds?realm=emberfall',
    });
    expect(byRealm.json().items).toHaveLength(1);

    // emberfall is US-only in allowlist — asking for it under eu filter → 400
    const realmWrongRegion = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/public/guilds?region=eu&realm=emberfall',
    });
    expect(realmWrongRegion.statusCode).toBe(400);

    const byFaction = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/public/guilds?faction=horde',
    });
    expect(byFaction.json().items[0].guild_slug).toBe('bravo');

    const byRoleClass = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/public/guilds?role=tank&class=warrior',
    });
    expect(byRoleClass.json().items.map((i: { guild_slug: string }) => i.guild_slug)).toEqual([
      'alpha',
    ]);

    const badRealm = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/public/guilds?realm=not-a-forever-realm',
    });
    expect(badRealm.statusCode).toBe(400);
    expect(badRealm.json().errors?.realm || badRealm.json().error?.code).toBeTruthy();
  });

  it('detail is /{region}/{realm}/{guild} with etag/304; bad region → 404', async () => {
    await seedPublicGuild(ctx, {
      name: 'Crusaders',
      region: 'us',
      realm_slug: 'emberfall',
      realm_name: 'Emberfall',
      guild_slug: 'crusaders',
      faction: 'alliance',
      public_member_count: 17,
    });
    await seedPublicGuild(ctx, {
      name: 'Secret',
      region: 'us',
      realm_slug: 'emberfall',
      realm_name: 'Emberfall',
      guild_slug: 'secret',
      faction: 'alliance',
      public_listed: false,
    });

    const ok = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/public/guilds/us/emberfall/crusaders',
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as {
      region: string;
      name: string;
      member_count: number;
      raid_timezone: string;
      emblem_url: string | null;
    };
    expect(body.region).toBe('us');
    expect(body.name).toBe('Crusaders');
    expect(body.member_count).toBe(17);
    expect(body.raid_timezone).toBe('America/Los_Angeles');
    expect(body.emblem_url).toBeNull();
    expect(ok.headers.etag).toBeTruthy();

    const cached = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/public/guilds/us/emberfall/crusaders',
      headers: { 'if-none-match': String(ok.headers.etag) },
    });
    expect(cached.statusCode).toBe(304);

    // Same guild under wrong region → 404
    const wrongRegion = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/public/guilds/eu/emberfall/crusaders',
    });
    expect(wrongRegion.statusCode).toBe(404);

    // Invalid region token → 404 (consistent with private/unknown)
    const badRegion = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/public/guilds/na/emberfall/crusaders',
    });
    expect(badRegion.statusCode).toBe(404);

    const priv = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/public/guilds/us/emberfall/secret',
    });
    expect(priv.statusCode).toBe(404);
    expect(priv.json().error.code).toBe('not_found');
  });

  it('sitemap includes region and paginates', async () => {
    const empty = await ctx.app.inject({ method: 'GET', url: '/api/v1/public/guilds/sitemap' });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ items: [], next_cursor: null });

    for (let i = 0; i < 3; i++) {
      await seedPublicGuild(ctx, {
        name: `G${i}`,
        region: i === 0 ? 'eu' : 'us',
        realm_slug: i === 0 ? 'normal' : 'emberfall',
        realm_name: i === 0 ? 'Normal' : 'Emberfall',
        guild_slug: `guild-${i}`,
        faction: 'alliance',
        updated_at: new Date(Date.UTC(2026, 10, 4, 12, i)).toISOString(),
      });
    }
    const page1 = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/public/guilds/sitemap?limit=2',
    });
    expect(page1.statusCode).toBe(200);
    const b1 = page1.json() as {
      items: { region: string; guild_slug: string }[];
      next_cursor: string | null;
    };
    expect(b1.items).toHaveLength(2);
    expect(b1.items[0]).toEqual(
      expect.objectContaining({ region: expect.stringMatching(/^(us|eu)$/) }),
    );
    expect(b1.next_cursor).toBeTruthy();
    const page2 = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/public/guilds/sitemap?limit=2&cursor=${encodeURIComponent(b1.next_cursor!)}`,
    });
    const b2 = page2.json() as { items: unknown[]; next_cursor: string | null };
    expect(b2.items).toHaveLength(1);
    expect(b2.next_cursor).toBeNull();
  });

  it('does not treat sitemap as a region or realm slug', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/public/guilds/sitemap' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });
});
