import type { FastifyInstance } from 'fastify';
import type { Pool } from '../db/pool.js';
import type { Config } from '../config.js';
import type { BlizzardClient } from '../blizzard/client.js';
import { randomToken, sha256Base64Url, isSafeReturnTo } from '../lib/crypto.js';
import { AppError, requestId } from '../lib/errors.js';
import * as store from '../auth/store.js';
import {
  clearSessionCookie,
  loadSession,
  requireCsrf,
  requireSession,
  setSessionCookie,
} from '../auth/session.js';

export type AuthDeps = {
  pool: Pool;
  config: Config;
  blizzard: BlizzardClient;
  /** Absolute redirect URI registered with Battle.net / mock. */
  redirectUri: string;
};

function webRedirect(config: Config, returnTo: string, params: Record<string, string>): string {
  const url = new URL(returnTo, config.PUBLIC_WEB_ORIGIN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): Promise<void> {
  const { pool, config, blizzard } = deps;

  app.addHook('preHandler', async (req) => {
    req.csSession = (await loadSession(pool, req)) ?? undefined;
  });

  app.get('/api/v1/auth/blizzard/login', async (req, reply) => {
    const q = req.query as { return_to?: string };
    const returnTo = q.return_to ?? '/signin.html';
    if (!isSafeReturnTo(returnTo)) {
      throw new AppError(400, 'validation_error', 'Invalid return_to.', {
        return_to: 'Must be a relative same-site path starting with a single /.',
      });
    }
    const state = randomToken(24);
    const codeVerifier = randomToken(32);
    const codeChallenge = sha256Base64Url(codeVerifier);
    await store.saveOauthState(pool, { state, codeVerifier, returnTo });
    const url = blizzard.buildAuthorizeUrl({ state, codeChallenge });
    return reply.redirect(url);
  });

  app.get('/api/v1/auth/blizzard/callback', async (req, reply) => {
    const q = req.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
    const state = q.state ?? '';
    const saved = state ? await store.takeOauthState(pool, state) : null;
    const returnTo = saved?.returnTo && isSafeReturnTo(saved.returnTo) ? saved.returnTo : '/signin.html';

    if (q.error === 'access_denied') {
      return reply.redirect(webRedirect(config, returnTo, { auth: 'cancelled' }));
    }
    if (!saved || !q.state) {
      return reply.redirect(webRedirect(config, returnTo, { auth: 'error', reason: 'invalid_state' }));
    }
    if (!q.code) {
      return reply.redirect(
        webRedirect(config, returnTo, { auth: 'error', reason: 'oauth_error' }),
      );
    }

    try {
      const token = await blizzard.exchangeCode({
        code: q.code,
        codeVerifier: saved.codeVerifier,
      });
      const userInfo = await blizzard.fetchUserInfo(token.access_token);
      const user = await store.upsertUserFromBattleNet(pool, {
        battlenetId: String(userInfo.id),
        battletag: userInfo.battletag,
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? null,
        expiresIn: token.expires_in,
      });
      try {
        const chars = await blizzard.fetchForeverCharacters(token.access_token, user.preferred_region);
        await store.replaceCharacters(pool, user.id, chars);
      } catch (err) {
        // Profile pull failure after token exchange still signs the user in; refresh can retry.
        req.log.warn({ err }, 'initial character pull failed');
      }
      const session = await store.createSession(pool, user.id);
      setSessionCookie(reply, session.id, { secure: config.cookieSecure });
      return reply.redirect(webRedirect(config, returnTo, { auth: 'ok' }));
    } catch (err) {
      const status = (err as { status?: number }).status;
      req.log.error({ err }, 'oauth callback failed');
      const reason = status && status >= 500 ? 'upstream_unavailable' : 'oauth_error';
      return reply.redirect(webRedirect(config, returnTo, { auth: 'error', reason }));
    }
  });

  app.get('/api/v1/auth/session', async (req) => {
    const s = requireSession(req);
    return {
      battletag: s.battletag,
      active_guild_id: s.activeGuildId,
      memberships: [],
      csrf_token: s.csrfToken,
    };
  });

  app.delete('/api/v1/auth/session', async (req, reply) => {
    requireCsrf(req);
    const s = requireSession(req);
    await store.revokeSession(pool, s.sessionId);
    clearSessionCookie(reply, config.cookieSecure);
    return reply.code(204).send();
  });
}
