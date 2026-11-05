/**
 * Permanent cookie-flag regression tests locking the #59 live audit into CI.
 * Refs platform#60, #59, #26.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { shutdownEmbeddedPg, signIn, startTestApp, type TestCtx } from './helpers/setup.js';

function setCookies(res: { headers: Record<string, unknown> }): string[] {
  const h = res.headers['set-cookie'];
  return Array.isArray(h) ? (h as string[]) : h ? [String(h)] : [];
}

function csSessionCookie(res: { headers: Record<string, unknown> }): string | undefined {
  return setCookies(res).find((v) => /^cs_session=/i.test(v));
}

/** Split a Set-Cookie header into name=value + attribute tokens (case-preserved). */
function cookieParts(header: string): { pair: string; attrs: string[] } {
  const segments = header.split(';').map((s) => s.trim());
  return { pair: segments[0] ?? '', attrs: segments.slice(1) };
}

function hasAttr(attrs: string[], name: string): boolean {
  const re = new RegExp(`^${name}$`, 'i');
  return attrs.some((a) => re.test(a));
}

function attrValue(attrs: string[], name: string): string | undefined {
  const re = new RegExp(`^${name}=(.+)$`, 'i');
  for (const a of attrs) {
    const m = a.match(re);
    if (m) return m[1];
  }
  return undefined;
}

/** Shared Path / Domain / SameSite / HttpOnly / Secure expectations from the #59 table. */
function expectSharedFlags(header: string, secure: boolean): void {
  const { attrs } = cookieParts(header);
  expect(hasAttr(attrs, 'HttpOnly')).toBe(true);
  expect(attrValue(attrs, 'SameSite')?.toLowerCase()).toBe('lax');
  expect(attrValue(attrs, 'Path')).toBe('/');
  expect(attrs.some((a) => /^Domain=/i.test(a))).toBe(false);
  if (secure) {
    expect(hasAttr(attrs, 'Secure')).toBe(true);
  } else {
    expect(hasAttr(attrs, 'Secure')).toBe(false);
  }
}

function expectIssuingCookie(header: string, secure: boolean): void {
  const { pair, attrs } = cookieParts(header);
  expect(pair).toMatch(/^cs_session=[0-9a-f-]{36}$/i);
  expect(attrValue(attrs, 'Max-Age')).toBe('2592000');
  expectSharedFlags(header, secure);
}

function expectClearingCookie(header: string, secure: boolean): void {
  const { pair, attrs } = cookieParts(header);
  expect(pair).toMatch(/^cs_session=$/i);
  const maxAge = attrValue(attrs, 'Max-Age');
  const expires = attrValue(attrs, 'Expires');
  const expired =
    maxAge === '0' || (expires !== undefined && /1970/i.test(expires));
  expect(expired).toBe(true);
  expectSharedFlags(header, secure);
}

describe('cs_session cookie flags (platform#60 / #59)', () => {
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

  it('issuing cookie on successful callback has Secure + shared flags (COOKIE_SECURE=true)', async () => {
    ctx = await startTestApp({ cookieSecure: true });
    expect(ctx.config.cookieSecure).toBe(true);

    const returnTo = '/signin.html';
    const login = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/auth/blizzard/login?return_to=${encodeURIComponent(returnTo)}`,
    });
    expect(login.statusCode).toBe(302);
    expect(csSessionCookie(login)).toBeUndefined();

    const { redirectTo } = ctx.mock.completeLogin({
      authorizeUrl: login.headers.location as string,
      outcome: 'ok',
    });
    const cbUrl = new URL(redirectTo);
    const callback = await ctx.app.inject({
      method: 'GET',
      url: cbUrl.pathname + cbUrl.search,
    });
    expect(callback.statusCode).toBe(302);
    expect(String(callback.headers.location)).toContain('auth=ok');

    const issued = csSessionCookie(callback);
    expect(issued).toBeDefined();
    expectIssuingCookie(issued!, true);
  });

  it('login start sets no cookie', async () => {
    ctx = await startTestApp({ cookieSecure: true });
    const login = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/blizzard/login?return_to=/signin.html',
    });
    expect(login.statusCode).toBe(302);
    expect(setCookies(login).length).toBe(0);
  });

  it('bogus callback sets or clears nothing', async () => {
    ctx = await startTestApp({ cookieSecure: true });
    const callback = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/blizzard/callback?code=x&state=not-a-real-state',
    });
    expect(callback.statusCode).toBe(302);
    expect(String(callback.headers.location)).toContain('reason=invalid_state');
    expect(setCookies(callback).length).toBe(0);

    const withBogus = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/blizzard/callback?code=x&state=also-bogus',
      headers: { cookie: 'cs_session=garbage-not-uuid' },
    });
    expect(withBogus.statusCode).toBe(302);
    expect(setCookies(withBogus).length).toBe(0);
  });

  it('no cookie → no Set-Cookie on session read', async () => {
    ctx = await startTestApp({ cookieSecure: true });
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/session' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    expect(setCookies(res).some((c) => /^cs_session=/i.test(c))).toBe(false);
  });

  it.each([
    ['UUID missing session', '00000000-0000-4000-8000-000000000099'],
    ['garbage non-UUID', 'garbage-not-uuid'],
  ])('session_expired with %s clears with matching Secure flags', async (_label, sid) => {
    ctx = await startTestApp({ cookieSecure: true });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { cookie: `cs_session=${sid}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'session_expired' } });
    const cleared = csSessionCookie(res);
    expect(cleared).toBeDefined();
    expectClearingCookie(cleared!, true);
  });

  it('logout with valid session clears with matching Secure flags', async () => {
    ctx = await startTestApp({ cookieSecure: true });
    const { cookie, csrf } = await signIn(ctx);
    const logout = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/session',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(logout.statusCode).toBe(204);
    const cleared = csSessionCookie(logout);
    expect(cleared).toBeDefined();
    expectClearingCookie(cleared!, true);
  });

  it('logout with bogus cookie → session_expired clear with matching Secure flags', async () => {
    ctx = await startTestApp({ cookieSecure: true });
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/session',
      headers: { cookie: 'cs_session=garbage-not-uuid', 'x-csrf-token': 'irrelevant' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'session_expired' } });
    const cleared = csSessionCookie(res);
    expect(cleared).toBeDefined();
    expectClearingCookie(cleared!, true);
  });

  it('harness default (COOKIE_SECURE=false) still issues without Secure; clear matches', async () => {
    ctx = await startTestApp();
    expect(ctx.config.cookieSecure).toBe(false);

    const returnTo = '/signin.html';
    const login = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/auth/blizzard/login?return_to=${encodeURIComponent(returnTo)}`,
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
    const issued = csSessionCookie(callback);
    expect(issued).toBeDefined();
    expectIssuingCookie(issued!, false);

    const { cookie, csrf } = await signIn(ctx);
    const logout = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/session',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(logout.statusCode).toBe(204);
    expectClearingCookie(csSessionCookie(logout)!, false);
  });
});
