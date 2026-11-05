import type { FastifyInstance } from 'fastify';
import type { Pool } from '../db/pool.js';
import type { Config } from '../config.js';
import type { BlizzardClient } from '../blizzard/client.js';
import {
  DEFAULT_RETURN_TO,
  encryptSecret,
  resolveSafeReturnTo,
  safeWebRedirect,
  randomToken,
  sha256Base64Url,
} from '../lib/crypto.js';
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

function truncateReturnTo(value: string, max = 64): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

/**
 * Client-supplied or stored return_to via the shared validator + origin-check (platform#68).
 * Invalid/missing → /profile/. Logs at most a truncated rejected value.
 */
function resolveReturnTo(
  siteOrigin: string,
  raw: string | undefined | null,
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
): string {
  const resolved = resolveSafeReturnTo(siteOrigin, raw);
  if (
    raw !== undefined &&
    raw !== null &&
    raw !== '' &&
    resolved === DEFAULT_RETURN_TO &&
    raw !== DEFAULT_RETURN_TO
  ) {
    log?.warn({ return_to_truncated: truncateReturnTo(raw) }, 'rejected return_to; using /profile/');
  }
  return resolved;
}

function webRedirect(config: Config, returnTo: string, params: Record<string, string>): string {
  try {
    return safeWebRedirect(config.PUBLIC_WEB_ORIGIN, returnTo, params);
  } catch {
    return safeWebRedirect(config.PUBLIC_WEB_ORIGIN, DEFAULT_RETURN_TO, params);
  }
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): Promise<void> {
  const { pool, config, blizzard } = deps;

  app.addHook('preHandler', async (req) => {
    req.csSession = (await loadSession(pool, req)) ?? undefined;
  });

  app.get('/api/v1/auth/blizzard/login', async (req, reply) => {
    const q = req.query as { return_to?: string };
    // Invalid / missing return_to soft-falls back to /profile/ (platform#64). Never 400.
    const returnTo = resolveReturnTo(config.PUBLIC_WEB_ORIGIN, q.return_to, req.log);
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
    // Never read return_to from the callback query — only the server-stored path (single-use via take).
    // Re-validate with the same shared helper used at start-auth (platform#68).
    const returnTo = resolveReturnTo(config.PUBLIC_WEB_ORIGIN, saved?.returnTo);

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
      const encAccess = encryptSecret(token.access_token, config.TOKEN_ENC_KEY);
      const encRefresh = token.refresh_token
        ? encryptSecret(token.refresh_token, config.TOKEN_ENC_KEY)
        : null;
      const user = await store.upsertUserFromBattleNet(pool, {
        battlenetId: String(userInfo.id),
        battletag: userInfo.battletag,
        accessToken: encAccess,
        refreshToken: encRefresh,
        expiresIn: token.expires_in,
        preferredRegion: config.BLIZZARD_REGION,
      });
      try {
        const chars = await blizzard.fetchForeverCharactersAll(token.access_token);
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
      // Failed exchange (including cross-login state/code tamper) must not land on the
      // stored return_to — always soft-fall back to /profile/ (platform#68).
      return reply.redirect(webRedirect(config, DEFAULT_RETURN_TO, { auth: 'error', reason }));
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
