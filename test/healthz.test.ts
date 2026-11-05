import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadConfig, normalizeBuildSha } from '../src/config.js';
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

    it('serves unknown when BUILD_SHA is a secret-looking string', async () => {
      ctx = await startTestApp({ buildSha: 'sk_live_not_a_git_sha_at_all' });
      expect(ctx.config.BUILD_SHA).toBe('unknown');
      const res = await ctx.app.inject({ method: 'GET', url: '/healthz' });
      expect(res.json()).toEqual({ ok: true, sha: 'unknown' });
    });
  });

  it('normalizeBuildSha / loadConfig accept only lowercase hex 7–40', () => {
    expect(normalizeBuildSha(undefined)).toBe('unknown');
    expect(normalizeBuildSha('')).toBe('unknown');
    expect(normalizeBuildSha('  ')).toBe('unknown');
    expect(normalizeBuildSha('1089acd')).toBe('1089acd');
    expect(normalizeBuildSha('  abcdef0  ')).toBe('abcdef0');
    expect(normalizeBuildSha('a'.repeat(40))).toBe('a'.repeat(40));
    // too short
    expect(normalizeBuildSha('abc123')).toBe('unknown');
    // too long
    expect(normalizeBuildSha('a'.repeat(41))).toBe('unknown');
    // uppercase / mixed
    expect(normalizeBuildSha('1089ACD')).toBe('unknown');
    expect(normalizeBuildSha('1089AcD')).toBe('unknown');
    // garbage
    expect(normalizeBuildSha('not-a-sha!')).toBe('unknown');
    expect(normalizeBuildSha('g123456')).toBe('unknown');
    // secret-looking
    expect(normalizeBuildSha('sk_live_abc123def456')).toBe('unknown');
    expect(normalizeBuildSha('postgres://user:pass@host/db')).toBe('unknown');

    const base = {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
      SESSION_SECRET: 'test-session-secret-at-least-32-chars!!',
      TOKEN_ENC_KEY: TEST_TOKEN_ENC_KEY,
      BLIZZARD_MOCK: 'true',
    } as NodeJS.ProcessEnv;

    expect(loadConfig(base).BUILD_SHA).toBe('unknown');
    expect(loadConfig({ ...base, BUILD_SHA: '' }).BUILD_SHA).toBe('unknown');
    expect(loadConfig({ ...base, BUILD_SHA: 'SK_LIVE_SECRET' }).BUILD_SHA).toBe('unknown');
    expect(loadConfig({ ...base, BUILD_SHA: 'DEADBEE' }).BUILD_SHA).toBe('unknown');
    expect(loadConfig({ ...base, BUILD_SHA: '!!garbage!!' }).BUILD_SHA).toBe('unknown');
    expect(loadConfig({ ...base, BUILD_SHA: '1089acd' }).BUILD_SHA).toBe('1089acd');
  });
});
