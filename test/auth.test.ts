import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  decryptSecret,
  encryptSecret,
  FORBIDDEN_TOKEN_ENC_KEYS,
  isSafeReturnTo,
  safeWebRedirect,
  TokenDecryptError,
  validateTokenEncKey,
} from '../src/lib/crypto.js';
import { sanitizeBlizzardIconUrl } from '../src/lib/icon-url.js';
import {
  shutdownEmbeddedPg,
  signIn,
  startTestApp,
  TEST_TOKEN_ENC_KEY,
  PROD_SAFE_TOKEN_ENC_KEY,
  type TestCtx,
} from './helpers/setup.js';

describe('Blizzard OAuth + characters (#11)', () => {
  let ctx: TestCtx;

  afterEach(async () => {
    if (ctx) await ctx.stop();
  });
  afterAll(async () => {
    await shutdownEmbeddedPg();
  });

  it('happy path: login, session, characters, selection, logout', async () => {
    ctx = await startTestApp();
    const { cookie, csrf, location } = await signIn(ctx);
    expect(location).toContain('auth=ok');
    expect(cookie.startsWith('cs_session=')).toBe(true);

    const session = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      battletag: 'Crusader#1234',
      csrf_token: csrf,
      memberships: [],
    });

    const chars = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me/characters',
      headers: { cookie },
    });
    expect(chars.statusCode).toBe(200);
    const list = chars.json() as {
      game: string;
      characters: Array<{ id: string; game: string; character_name: string; region: string }>;
      selection: null;
    };
    expect(list.game).toBe('wow_forever');
    expect(list.selection).toBeNull();
    expect(list.characters.every((c) => c.game === 'wow_forever')).toBe(true);
    expect(list.characters.map((c) => c.character_name)).toEqual(
      expect.arrayContaining(['Lightbringer', 'Ashenvow', 'Thornquill', 'Grimlantern', 'Stormcaller']),
    );
    expect(list.characters.find((c) => c.character_name === 'Filtered')).toBeUndefined();
    expect(list.characters.find((c) => c.character_name === 'Stormcaller')?.region).toBe('eu');
    expect(list.characters.find((c) => c.character_name === 'Lightbringer')?.region).toBe('us');
    expect(list.characters.find((c) => c.character_name === 'Lightbringer')?.id).toMatch(/^ch_us_/);

    const main = list.characters.find((c) => c.character_name === 'Lightbringer')!;
    const alt = list.characters.find((c) => c.character_name === 'Thornquill')!;
    const save = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/me/characters/selection',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: { main_id: main.id, alt_ids: [alt.id] },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json()).toMatchObject({
      selection: { main_id: main.id, alt_ids: [alt.id] },
    });

    const profile = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me/profile',
      headers: { cookie },
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toMatchObject({
      battletag: 'Crusader#1234',
      main_character_id: main.id,
    });

    const logout = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/session',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(logout.statusCode).toBe(204);

    const after = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it('cancelled OAuth redirects with auth=cancelled', async () => {
    ctx = await startTestApp();
    const { location } = await signIn(ctx, { outcome: 'access_denied' });
    expect(location).toContain('auth=cancelled');
    expect(location).not.toContain('auth=ok');
  });

  it('invalid state redirects with auth=error&reason=invalid_state', async () => {
    ctx = await startTestApp();
    const callback = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/blizzard/callback?code=x&state=not-a-real-state',
    });
    expect(callback.statusCode).toBe(302);
    expect(String(callback.headers.location)).toContain('auth=error');
    expect(String(callback.headers.location)).toContain('reason=invalid_state');
  });

  it('upstream 5xx on token exchange → auth=error&reason=upstream_unavailable', async () => {
    ctx = await startTestApp({ failUpstream: true });
    const login = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/blizzard/login?return_to=/signin.html',
    });
    const { redirectTo } = ctx.mock.completeLogin({
      authorizeUrl: login.headers.location as string,
      outcome: 'ok',
    });
    const cbUrl = new URL(redirectTo);
    const callback = await ctx.app.inject({
      method: 'GET',
      url: cbUrl.pathname + cbUrl.search,
    });
    expect(String(callback.headers.location)).toContain('reason=upstream_unavailable');
  });

  it('rejects unsafe return_to including open-redirect variants', async () => {
    ctx = await startTestApp();
    const cases = [
      'https://evil.example/',
      '//evil.com',
      '/\\evil.com',
      '/%09/evil.com',
      '/%0a/evil.com',
      '/%0d/evil.com',
      encodeURIComponent('//evil.com'),
      '/%5cevil.com',
    ];
    for (const value of cases) {
      const bad = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/auth/blizzard/login?return_to=' + value,
      });
      expect(bad.statusCode, `return_to=${value}`).toBe(400);
    }
    // Unit: control-char path must not pass isSafeReturnTo / safeWebRedirect
    expect(isSafeReturnTo('/\t/evil.com')).toBe(false);
    expect(isSafeReturnTo('/%09/evil.com')).toBe(false);
    expect(isSafeReturnTo('/%2F%2Fevil.com')).toBe(false); // normalizes to //evil.com
    expect(isSafeReturnTo('/%2f/evil.com')).toBe(false); // normalizes to ///evil.com → starts with //
    expect(() => safeWebRedirect('https://crusaderstrike.com', '/\t/evil.com')).toThrow();
  });

  it('CSRF required on selection; mismatch → 403 csrf_failed', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const chars = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me/characters',
      headers: { cookie },
    });
    const main = (chars.json() as { characters: Array<{ id: string }> }).characters[0]!;

    const noCsrf = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/me/characters/selection',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { main_id: main.id, alt_ids: [] },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toMatchObject({ error: { code: 'csrf_failed' } });

    const bad = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/me/characters/selection',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': 'nope' },
      payload: { main_id: main.id, alt_ids: [] },
    });
    expect(bad.statusCode).toBe(403);

    const ok = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/me/characters/selection',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: { main_id: main.id, alt_ids: [] },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('main/alt switching validates ownership and rejects main in alts', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const chars = (
      await ctx.app.inject({ method: 'GET', url: '/api/v1/me/characters', headers: { cookie } })
    ).json() as { characters: Array<{ id: string }> };
    const [a, b] = chars.characters;
    const bad = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/me/characters/selection',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: { main_id: a!.id, alt_ids: [a!.id] },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/me/characters/selection',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: { main_id: b!.id, alt_ids: [a!.id] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ selection: { main_id: b!.id, alt_ids: [a!.id] } });
  });

  it('refresh returns CharacterList; second call within 60s → 429 Retry-After', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/me/characters/refresh',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ game: 'wow_forever' });

    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/me/characters/refresh',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBeTruthy();
    expect(second.json()).toMatchObject({ error: { code: 'rate_limited' } });
  });

  it('refresh upstream failure → 502 upstream_unavailable', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    ctx.mock.options.failUpstream = true;
    await ctx.app.clearRefreshCooldowns?.();
    const refresh = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/me/characters/refresh',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(refresh.statusCode).toBe(502);
    expect(refresh.json()).toMatchObject({ error: { code: 'upstream_unavailable' } });
  });

  it('PUT gear owner-only with camelCase itemId; GET returns it', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const chars = (
      await ctx.app.inject({ method: 'GET', url: '/api/v1/me/characters', headers: { cookie } })
    ).json() as { characters: Array<{ id: string }> };
    const id = chars.characters[0]!.id;

    const put = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/characters/${id}/gear`,
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: {
        items: [
          { slot: 'head', itemId: 12345, name: 'Crown', quality: 'epic', ilvl: 60, icon: 'inv_helmet' },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    const putBody = put.json() as {
      character_id: string;
      items: Array<{ slot: string; itemId: number; icon: string | null; icon_url: string | null }>;
    };
    expect(putBody).toMatchObject({
      character_id: id,
      items: [{ slot: 'head', itemId: 12345, name: 'Crown' }],
    });
    expect(putBody.items[0]!.icon_url).toMatch(/^https:\/\/render\.worldofwarcraft\.com\//);
    expect(putBody.items[0]!.icon).toBeTruthy();

    const get = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/characters/${id}/gear`,
      headers: { cookie },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({
      character_id: id,
      items: [{ itemId: 12345, icon_url: putBody.items[0]!.icon_url }],
    });

    // Cache hit: second PUT with same itemId does not need a new upstream shape
    const put2 = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/characters/${id}/gear`,
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: { items: [{ slot: 'head', itemId: 12345, name: 'Crown2', quality: 'epic', ilvl: 60 }] },
    });
    expect(put2.statusCode).toBe(200);
    expect(put2.json()).toMatchObject({
      items: [{ itemId: 12345, icon_url: putBody.items[0]!.icon_url }],
    });
  });

  it('rejects unknown profile fields with 400', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const bad = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/me/profile',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      payload: { preferred_region: 'eu', battletag: 'Nope#1' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ errors: { body: expect.stringContaining('Unknown') } });
  });

  it('encrypts Blizzard tokens at rest', async () => {
    ctx = await startTestApp();
    await signIn(ctx);
    const row = await ctx.pool.query<{ access_token: string; refresh_token: string }>(
      `SELECT access_token, refresh_token FROM users LIMIT 1`,
    );
    expect(row.rows[0]!.access_token.startsWith('v1:')).toBe(true);
    expect(row.rows[0]!.refresh_token.startsWith('v1:')).toBe(true);
    expect(row.rows[0]!.access_token.includes('access_')).toBe(false);
  });

  it('429 refresh exposes Retry-After to credentialed CORS browsers', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/me/characters/refresh',
      headers: {
        cookie,
        'x-csrf-token': csrf,
        origin: 'https://crusaderstrike.com',
      },
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/me/characters/refresh',
      headers: {
        cookie,
        'x-csrf-token': csrf,
        origin: 'https://crusaderstrike.com',
      },
    });
    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBeTruthy();
    const expose = String(second.headers['access-control-expose-headers'] ?? '');
    expect(expose.toLowerCase().split(/,\s*/)).toContain('retry-after');
  });


  it('rejects invalid Blizzard icon media URLs (http/wrong/lookalike/malformed)', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const chars = (
      await ctx.app.inject({ method: 'GET', url: '/api/v1/me/characters', headers: { cookie } })
    ).json() as { characters: Array<{ id: string }> };
    const id = chars.characters[0]!.id;

    const cases = [
      { itemId: 90001, label: 'http' },
      { itemId: 90002, label: 'wrong host' },
      { itemId: 90003, label: 'lookalike' },
      { itemId: 90004, label: 'malformed' },
    ];
    for (const c of cases) {
      const put = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/characters/${id}/gear`,
        headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
        payload: { items: [{ slot: 'head', itemId: c.itemId, name: c.label }] },
      });
      expect(put.statusCode, c.label).toBe(200);
      const items = (put.json() as { items: Array<{ icon_url: string | null }> }).items;
      expect(items[0]!.icon_url, c.label).toBeNull();
      const cached = await ctx.pool.query<{ icon_url: string | null }>(
        `SELECT icon_url FROM item_icon_cache WHERE item_id = $1`,
        [c.itemId],
      );
      // Cached null is fine; must never store the invalid URL string
      expect(cached.rows[0]?.icon_url ?? null, c.label).toBeNull();
    }
  });

  it('refresh with non-v1 token → 401 and tokens cleared', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    await ctx.pool.query(`UPDATE users SET access_token = 'plaintext_access', refresh_token = 'plaintext_refresh'`);
    await ctx.app.clearRefreshCooldowns?.();
    const refresh = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/me/characters/refresh',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(refresh.statusCode).toBe(401);
    expect(refresh.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    const row = await ctx.pool.query<{ access_token: string | null }>(
      `SELECT access_token FROM users LIMIT 1`,
    );
    expect(row.rows[0]!.access_token).toBeNull();
  });
});

describe('config guards', () => {
  const base = {
    DATABASE_URL: 'postgres://x:x@127.0.0.1:5432/x',
    SESSION_SECRET: 'test-session-secret-at-least-32-chars!!',
    BLIZZARD_CLIENT_ID: 'id',
    BLIZZARD_CLIENT_SECRET: 'secret',
  };

  it('BLIZZARD_MOCK defaults to false', () => {
    const cfg = loadConfig({
      ...base,
      NODE_ENV: 'development',
      TOKEN_ENC_KEY: TEST_TOKEN_ENC_KEY,
    });
    expect(cfg.BLIZZARD_MOCK).toBe(false);
  });

  it('fails when NODE_ENV=production and BLIZZARD_MOCK=true', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        TOKEN_ENC_KEY: PROD_SAFE_TOKEN_ENC_KEY,
        BLIZZARD_MOCK: 'true',
      }),
    ).toThrow(/BLIZZARD_MOCK/);
  });

  it('rejects unknown region in BLIZZARD_REGIONS at startup', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'development',
        TOKEN_ENC_KEY: TEST_TOKEN_ENC_KEY,
        BLIZZARD_MOCK: 'true',
        BLIZZARD_REGIONS: 'us,cn',
      }),
    ).toThrow(/Unsupported Blizzard region/);
  });

  it('rejects example TOKEN_ENC_KEY in production without echoing the key', () => {
    const example = [...FORBIDDEN_TOKEN_ENC_KEYS][0]!;
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        TOKEN_ENC_KEY: example,
      }),
    ).toThrow(/example\/placeholder/);
    try {
      loadConfig({ ...base, NODE_ENV: 'production', TOKEN_ENC_KEY: example });
    } catch (err) {
      expect(String(err)).not.toContain(example);
    }
  });

  it('rejects short and malformed TOKEN_ENC_KEY', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'development', TOKEN_ENC_KEY: 'abcd' }),
    ).toThrow(/64 hex/);
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', TOKEN_ENC_KEY: 'zz'.repeat(32) }),
    ).toThrow(/64 hex/);
  });

  it('rejects low-entropy TOKEN_ENC_KEY in production', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        TOKEN_ENC_KEY: '0'.repeat(64),
      }),
    ).toThrow(/low-entropy/);
  });

  it('accepts a valid TOKEN_ENC_KEY in production', () => {
    const cfg = loadConfig({
      ...base,
      NODE_ENV: 'production',
      TOKEN_ENC_KEY: PROD_SAFE_TOKEN_ENC_KEY,
      BLIZZARD_MOCK: 'false',
    });
    expect(cfg.TOKEN_ENC_KEY).toBe(PROD_SAFE_TOKEN_ENC_KEY);
  });
});

describe('token encryption', () => {
  it('v1: round-trip', () => {
    const key = PROD_SAFE_TOKEN_ENC_KEY;
    const enc = encryptSecret('access_hello', key);
    expect(enc.startsWith('v1:')).toBe(true);
    expect(decryptSecret(enc, key)).toBe('access_hello');
  });

  it('rejects unprefixed plaintext tokens everywhere', () => {
    expect(() => decryptSecret('access_plain', PROD_SAFE_TOKEN_ENC_KEY)).toThrow(TokenDecryptError);
    try {
      decryptSecret('access_plain', PROD_SAFE_TOKEN_ENC_KEY);
    } catch (err) {
      expect(err).toBeInstanceOf(TokenDecryptError);
      expect((err as TokenDecryptError).code).toBe('missing_prefix');
    }
  });

  it('decrypts with TOKEN_ENC_KEY_PREVIOUS during rotation', () => {
    const oldKey = PROD_SAFE_TOKEN_ENC_KEY;
    const newKey = 'ff' + PROD_SAFE_TOKEN_ENC_KEY.slice(2);
    const enc = encryptSecret('tok', oldKey);
    expect(decryptSecret(enc, newKey, { previousKeyHex: oldKey })).toBe('tok');
  });

  it('validateTokenEncKey covers example and length', () => {
    expect(validateTokenEncKey(TEST_TOKEN_ENC_KEY).ok).toBe(false);
    expect(validateTokenEncKey(PROD_SAFE_TOKEN_ENC_KEY).ok).toBe(true);
    expect(validateTokenEncKey('short').ok).toBe(false);
  });
});

describe('blizzard icon_url sanitizer', () => {
  it('accepts https://render.worldofwarcraft.com', () => {
    const u = 'https://render.worldofwarcraft.com/us/icons/56/inv_helmet_03.jpg';
    expect(sanitizeBlizzardIconUrl(u)).toBe(u);
  });

  it('rejects http URLs', () => {
    expect(
      sanitizeBlizzardIconUrl('http://render.worldofwarcraft.com/us/icons/56/inv.jpg'),
    ).toBeNull();
  });

  it('rejects wrong host', () => {
    expect(sanitizeBlizzardIconUrl('https://evil.example/us/icons/56/inv.jpg')).toBeNull();
  });

  it('rejects lookalike host', () => {
    expect(
      sanitizeBlizzardIconUrl(
        'https://render.worldofwarcraft.com.evil.com/us/icons/56/inv.jpg',
      ),
    ).toBeNull();
  });

  it('rejects malformed values', () => {
    expect(sanitizeBlizzardIconUrl('not a url')).toBeNull();
    expect(sanitizeBlizzardIconUrl('')).toBeNull();
    expect(sanitizeBlizzardIconUrl(null)).toBeNull();
    expect(sanitizeBlizzardIconUrl(undefined)).toBeNull();
  });
});
