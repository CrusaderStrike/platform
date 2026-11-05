import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  shutdownEmbeddedPg,
  signIn,
  startTestApp,
  type TestCtx,
} from './helpers/setup.js';
import { ERROR_CATALOG } from '../src/lib/errors.js';

function expectError(
  res: { statusCode: number; json: () => unknown; headers: Record<string, unknown> },
  opts: {
    status: number;
    code: string;
    retryable: boolean;
    retryAfter?: boolean;
  },
) {
  expect(res.statusCode).toBe(opts.status);
  const body = res.json() as {
    error: { code: string; message: string; retryable: boolean; request_id: string };
  };
  expect(body.error).toMatchObject({
    code: opts.code,
    retryable: opts.retryable,
  });
  expect(typeof body.error.message).toBe('string');
  expect(body.error.message.length).toBeGreaterThan(0);
  expect(typeof body.error.request_id).toBe('string');
  const raw = JSON.stringify(body);
  expect(raw).not.toMatch(/at\s+\S+\s+\(/);
  expect(raw).not.toMatch(/blizzard_(token|profile|userinfo)_/i);
  expect(raw).not.toMatch(/access_token|refresh_token|TOKEN_ENC/i);
  expect(Object.keys(body.error).sort()).toEqual(
    ['code', 'message', 'request_id', 'retryable'].sort(),
  );
  if (opts.retryAfter) {
    expect(res.headers['retry-after']).toBeDefined();
  }
}

describe('stable error envelopes (platform#51)', () => {
  let ctx: TestCtx | undefined;

  afterEach(async () => {
    if (ctx) {
      await ctx.stop();
      ctx = undefined;
    }
  });
  afterAll(async () => {
    await shutdownEmbeddedPg();
  });

  describe('gear-lists', () => {
    it('unauthenticated when no session cookie', async () => {
      ctx = await startTestApp();
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/characters/ch_us_x/gear-lists',
      });
      expectError(res, {
        status: 401,
        code: 'unauthenticated',
        retryable: ERROR_CATALOG.unauthenticated.retryable,
      });
    });

    it('session_expired when cookie present but session revoked', async () => {
      ctx = await startTestApp();
      const { cookie } = await signIn(ctx);
      await ctx.pool.query(`UPDATE sessions SET revoked_at = now()`);
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/characters/ch_us_x/gear-lists',
        headers: { cookie },
      });
      expectError(res, { status: 401, code: 'session_expired', retryable: false });
    });

    it('session_expired on /ops with expired session', async () => {
      ctx = await startTestApp();
      const { cookie, csrf } = await signIn(ctx);
      await ctx.pool.query(`UPDATE sessions SET expires_at = now() - interval '1 hour'`);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/gear-lists/00000000-0000-4000-8000-000000000001/ops',
        headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
        payload: { ops: [] },
      });
      expectError(res, { status: 401, code: 'session_expired', retryable: false });
    });

    it('session_expired on /sync with revoked session', async () => {
      ctx = await startTestApp();
      const { cookie, csrf } = await signIn(ctx);
      await ctx.pool.query(`UPDATE sessions SET revoked_at = now()`);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/sync',
        headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
        payload: { character_id: 'ch_us_x', source: 'addon', lists: [] },
      });
      expectError(res, { status: 401, code: 'session_expired', retryable: false });
    });

    it('unauthenticated on /ops with no cookie', async () => {
      ctx = await startTestApp();
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/gear-lists/00000000-0000-4000-8000-000000000001/ops',
        headers: { 'content-type': 'application/json', 'x-csrf-token': 'x' },
        payload: { ops: [] },
      });
      expectError(res, { status: 401, code: 'unauthenticated', retryable: false });
    });
  });

  describe('selection', () => {
    it('unauthenticated on PUT selection without cookie', async () => {
      ctx = await startTestApp();
      const res = await ctx.app.inject({
        method: 'PUT',
        url: '/api/v1/me/characters/selection',
        headers: { 'content-type': 'application/json', 'x-csrf-token': 'x' },
        payload: { displayed_character_ids: [] },
      });
      expectError(res, { status: 401, code: 'unauthenticated', retryable: false });
    });

    it('session_expired on PUT selection with revoked session', async () => {
      ctx = await startTestApp();
      const { cookie, csrf } = await signIn(ctx);
      await ctx.pool.query(`UPDATE sessions SET revoked_at = now()`);
      const res = await ctx.app.inject({
        method: 'PUT',
        url: '/api/v1/me/characters/selection',
        headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
        payload: { displayed_character_ids: [] },
      });
      expectError(res, { status: 401, code: 'session_expired', retryable: false });
    });

    it('upstream_unavailable on refresh when Battle.net fails (retryable)', async () => {
      ctx = await startTestApp();
      const { cookie, csrf } = await signIn(ctx);
      ctx.mock.options.failUpstream = true;
      await ctx.app.clearRefreshCooldowns?.();
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/me/characters/refresh',
        headers: { cookie, 'x-csrf-token': csrf },
      });
      expectError(res, {
        status: 502,
        code: 'upstream_unavailable',
        retryable: true,
      });
    });

    it('session_expired on refresh when Blizzard token ciphertext is invalid', async () => {
      ctx = await startTestApp();
      const { cookie, csrf } = await signIn(ctx);
      await ctx.pool.query(
        `UPDATE users SET access_token = 'plaintext_access', refresh_token = 'plaintext_refresh'`,
      );
      await ctx.app.clearRefreshCooldowns?.();
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/me/characters/refresh',
        headers: { cookie, 'x-csrf-token': csrf },
      });
      expectError(res, { status: 401, code: 'session_expired', retryable: false });
    });
  });

  describe('items', () => {
    it('validation_error field map stays backward compatible', async () => {
      ctx = await startTestApp();
      const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/items?slot=not_a_slot' });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { errors: Record<string, string>; error?: unknown };
      expect(body.errors).toMatchObject({ slot: 'invalid_slot' });
      expect(body.error).toBeUndefined();
    });

    it('not_found envelope includes retryable:false', async () => {
      ctx = await startTestApp();
      const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/items/999999999' });
      expectError(res, { status: 404, code: 'not_found', retryable: false });
    });
  });

  it('ERROR_CATALOG documents the required platform#51 codes', () => {
    for (const code of ['unauthenticated', 'session_expired', 'upstream_unavailable'] as const) {
      expect(ERROR_CATALOG[code].retryable).toBe(
        code === 'upstream_unavailable',
      );
      expect(ERROR_CATALOG[code].status).toBe(code === 'upstream_unavailable' ? 502 : 401);
    }
  });
});
