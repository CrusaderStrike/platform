import Fastify from 'fastify';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { shutdownEmbeddedPg, signIn, startTestApp, type TestCtx } from './helpers/setup.js';
import { registerErrorHandler } from '../src/app.js';
import { AppError, isUuid, publicErrorBody } from '../src/lib/errors.js';

function setCookies(res: { headers: Record<string, unknown> }): string[] {
  const h = res.headers['set-cookie'];
  return Array.isArray(h) ? (h as string[]) : h ? [String(h)] : [];
}
function expectSessionCleared(res: { headers: Record<string, unknown> }) {
  const c = setCookies(res).find((v) => v.startsWith('cs_session='));
  expect(c).toBeDefined();
  expect(c).toMatch(/^cs_session=;/);
  expect(c).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
}

describe('error envelope follow-ups (platform#53)', () => {
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

  it('isUuid accepts canonical UUIDs only', () => {
    expect(isUuid('00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid("x' OR 1=1 --")).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });

  it.each([
    ['GET', '/api/v1/characters/ch_us_x/gear-lists'],
    ['POST', '/api/v1/gear-lists/00000000-0000-4000-8000-000000000001/ops'],
    ['GET', '/api/v1/me/profile'],
  ])('(a) non-UUID cs_session on %s %s → 401 session_expired + cookie cleared', async (method, url) => {
    ctx = await startTestApp();
    const res = await ctx.app.inject({
      method: method as 'GET' | 'POST',
      url,
      headers: { cookie: 'cs_session=garbage-not-uuid', 'content-type': 'application/json' },
      ...(method === 'POST' ? { payload: { ops: [] } } : {}),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'session_expired', retryable: false } });
    expectSessionCleared(res);
  });

  it('(c) revoked session → session_expired clears cookie', async () => {
    ctx = await startTestApp();
    const { cookie } = await signIn(ctx);
    await ctx.pool.query(`UPDATE sessions SET revoked_at = now()`);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/characters/ch_us_x/gear-lists',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'session_expired' } });
    expectSessionCleared(res);
  });

  it('unauthenticated (no cookie) does not set a clearing cookie', async () => {
    ctx = await startTestApp();
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/characters/ch_us_x/gear-lists' });
    expect(res.statusCode).toBe(401);
    expect(setCookies(res).some((c) => c.startsWith('cs_session='))).toBe(false);
  });

  it.each(['{"ops": [', '{bad json}', 'not json at all'])(
    '(b) malformed JSON on /ops (%s) → 400 invalid_json',
    async (payload) => {
      ctx = await startTestApp();
      const { cookie, csrf } = await signIn(ctx);
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/gear-lists/00000000-0000-4000-8000-000000000001/ops',
        headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ errors: { body: 'invalid_json' }, message: 'Request body is not valid JSON.' });
    },
  );

  it('(b) malformed JSON on another JSON route (create gear list) → 400 invalid_json', async () => {
    ctx = await startTestApp();
    const { cookie, csrf } = await signIn(ctx);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/characters/ch_us_x/gear-lists',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      payload: '{"name":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ errors: { body: 'invalid_json' }, message: 'Request body is not valid JSON.' });
  });

  it('(d) 500 omits stack and internal message', async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app, { cookieSecure: false });
    app.get('/boom', async () => {
      const e = new Error('SECRET_INTERNAL_detail: connect ECONNREFUSED 10.0.0.5:5432 password=hunter2');
      throw e;
    });
    app.get('/pg', async () => {
      const e = Object.assign(new Error('invalid input syntax for type uuid: "x"'), { code: '22P02' });
      throw e;
    });
    for (const url of ['/boom', '/pg']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(500);
      const body = res.json() as { error: Record<string, unknown> };
      expect(body).toEqual({
        error: {
          code: 'internal_error',
          message: 'Something went wrong.',
          retryable: true,
          request_id: expect.any(String),
        },
      });
      expect(res.body).not.toMatch(/SECRET_INTERNAL|ECONNREFUSED|hunter2|invalid input syntax|22P02/);
      expect(res.body).not.toMatch(/at\s+\S+\s+\(|\.ts:\d+|stack/i);
    }
    await app.close();
  });

  it('(f) AppError details are serialized; absent details omitted', () => {
    const withD = publicErrorBody('list_limit_reached', 'm', 'r', false, { limit: 20 });
    expect(withD.error.details).toEqual({ limit: 20 });
    const without = publicErrorBody('not_found', 'm', 'r', false);
    expect('details' in without.error).toBe(false);
    const e = new AppError(409, 'list_limit_reached', 'm', undefined, { details: { limit: 20 } });
    expect(e.details).toEqual({ limit: 20 });
  });
});
