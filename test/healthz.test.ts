import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  shutdownEmbeddedPg,
  startTestApp,
  TEST_TOKEN_ENC_KEY,
  type TestCtx,
} from './helpers/setup.js';

describe('/healthz build sha (platform#49)', () => {
  describe('HTTP shape', () => {
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

    it('returns {ok:true,sha} only; defaults to unknown when BUILD_SHA unset', async () => {
      ctx = await startTestApp();
      expect(ctx.config.BUILD_SHA).toBe('unknown');

      for (const url of ['/healthz', '/api/v1/healthz'] as const) {
        const res = await ctx.app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/application\/json/);
        const body = res.json() as Record<string, unknown>;
        expect(body).toEqual({ ok: true, sha: 'unknown' });
        expect(Object.keys(body).sort()).toEqual(['ok', 'sha']);
      }
    });

    it('exposes the baked BUILD_SHA and nothing else', async () => {
      ctx = await startTestApp({ buildSha: '1089acd' });
      expect(ctx.config.BUILD_SHA).toBe('1089acd');

      const res = await ctx.app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body).toEqual({ ok: true, sha: '1089acd' });
      expect(body).not.toHaveProperty('version');
      expect(body).not.toHaveProperty('env');
      expect(body).not.toHaveProperty('node');
    });
  });

  it('loadConfig trims BUILD_SHA and treats blank as unknown', () => {
    const base = {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
      SESSION_SECRET: 'test-session-secret-at-least-32-chars!!',
      TOKEN_ENC_KEY: TEST_TOKEN_ENC_KEY,
      BLIZZARD_MOCK: 'true',
    } as NodeJS.ProcessEnv;

    expect(loadConfig(base).BUILD_SHA).toBe('unknown');
    expect(loadConfig({ ...base, BUILD_SHA: '  ' }).BUILD_SHA).toBe('unknown');
    expect(loadConfig({ ...base, BUILD_SHA: ' abc123 ' }).BUILD_SHA).toBe('abc123');
  });
});
