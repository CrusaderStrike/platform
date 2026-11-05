import type { FastifyInstance } from 'fastify';
import type { Pool } from '../db/pool.js';
import type { Config } from '../config.js';
import type { BlizzardClient } from '../blizzard/client.js';
import { decryptSecret, TokenDecryptError } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { isBlizzardRegion } from '../blizzard/regions.js';
import * as store from '../auth/store.js';
import * as gear from '../gear/store.js';
import { clearSessionCookie, requireCsrf, requireSession } from '../auth/session.js';

const REFRESH_COOLDOWN_MS = 60_000;

export type ProfileDeps = {
  pool: Pool;
  config: Config;
  blizzard: BlizzardClient;
};

function characterListBody(chars: store.CharacterRow[], selection: store.SelectionRow) {
  return {
    game: 'wow_forever' as const,
    characters: chars.map(store.characterToApi),
    selection: store.selectionToApi(selection),
  };
}

function profileBody(user: store.UserRow, selection: store.SelectionRow) {
  return {
    battletag: user.battletag,
    preferred_region: user.preferred_region,
    // Compat: persisted main while displayed, else first displayed, else null.
    main_character_id: selection.main_id,
    created_at: user.created_at.toISOString(),
    updated_at: user.updated_at.toISOString(),
  };
}

const PROFILE_UPDATE_KEYS = new Set(['preferred_region']);

type ParsedSelection = {
  ids: string[];
  /** Explicit main for legacy body; first id for the new shape. */
  mainId: string | null;
  shape: 'displayed' | 'legacy';
};

/** Parse new `{displayed_character_ids}` or legacy `{main_id, alt_ids}` (order preserved). */
function parseDisplayedIds(body: Record<string, unknown>): ParsedSelection {
  if (Array.isArray(body.displayed_character_ids)) {
    const rawIds = body.displayed_character_ids;
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const id of rawIds) {
      if (typeof id !== 'string' || !id) {
        throw new AppError(400, 'validation_error', 'Invalid selection.', {
          displayed_character_ids: 'unknown_character',
        });
      }
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return { ids, mainId: ids[0] ?? null, shape: 'displayed' };
  }

  // Legacy body used by live crusaderstrike.com until web#43.
  if ('main_id' in body || 'alt_ids' in body) {
    const seen = new Set<string>();
    const ids: string[] = [];
    let mainId: string | null = null;
    const main = body.main_id;
    if (main !== undefined && main !== null) {
      if (typeof main !== 'string' || !main) {
        throw new AppError(400, 'validation_error', 'Invalid selection.', {
          main_id: 'Must be a character id or null.',
        });
      }
      mainId = main;
      seen.add(main);
      ids.push(main);
    }
    const alts = body.alt_ids;
    if (alts !== undefined) {
      if (!Array.isArray(alts)) {
        throw new AppError(400, 'validation_error', 'Invalid selection.', {
          alt_ids: 'Must be an array of character ids.',
        });
      }
      for (const id of alts) {
        if (typeof id !== 'string' || !id) {
          throw new AppError(400, 'validation_error', 'Invalid selection.', {
            alt_ids: 'unknown_character',
          });
        }
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
    }
    return { ids, mainId, shape: 'legacy' };
  }

  throw new AppError(400, 'validation_error', 'Invalid selection.', {
    displayed_character_ids: 'Must be an array of character ids.',
  });
}

async function requireGearWriteRate(pool: Pool, userId: string, reply: { header: (k: string, v: string) => unknown }) {
  const rate = await gear.consumeGearWrite(pool, userId);
  if (!rate.ok) {
    reply.header('Retry-After', String(rate.retryAfterSec));
    throw new AppError(429, 'rate_limited', 'Too many writes. Try again shortly.', undefined, {
      retryAfterSec: rate.retryAfterSec,
    });
  }
}

export async function registerProfileRoutes(app: FastifyInstance, deps: ProfileDeps): Promise<void> {
  const { pool, config, blizzard } = deps;

  app.get('/api/v1/me/profile', async (req) => {
    const s = requireSession(req);
    const user = await store.getUser(pool, s.userId);
    if (!user) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    const selection = await store.getSelection(pool, s.userId);
    return profileBody(user, selection);
  });

  app.put('/api/v1/me/profile', async (req) => {
    requireCsrf(req);
    const s = requireSession(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError(400, 'validation_error', 'Invalid profile.', {
        body: 'Expected a JSON object.',
      });
    }
    const unknown = Object.keys(body).filter((k) => !PROFILE_UPDATE_KEYS.has(k));
    if (unknown.length) {
      throw new AppError(400, 'validation_error', 'Unknown profile fields.', {
        body: `Unknown fields: ${unknown.join(', ')}`,
      });
    }
    if (body.preferred_region !== undefined) {
      if (typeof body.preferred_region !== 'string' || !isBlizzardRegion(body.preferred_region)) {
        throw new AppError(400, 'validation_error', 'Invalid preferred_region.', {
          preferred_region: 'Must be us, eu, kr, or tw.',
        });
      }
      await store.updatePreferredRegion(pool, s.userId, body.preferred_region);
    }
    const user = await store.getUser(pool, s.userId);
    if (!user) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    const selection = await store.getSelection(pool, s.userId);
    return profileBody(user, selection);
  });

  app.get('/api/v1/me/characters', async (req) => {
    const s = requireSession(req);
    const chars = await store.listCharacters(pool, s.userId);
    const selection = await store.getSelection(pool, s.userId);
    return characterListBody(chars, selection);
  });

  app.patch('/api/v1/me/characters/:characterId', async (req, reply) => {
    requireCsrf(req);
    const s = requireSession(req);
    await requireGearWriteRate(pool, s.userId, reply);
    const { characterId } = req.params as { characterId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError(400, 'validation_error', 'Invalid character update.', {
        body: 'Expected a JSON object.',
      });
    }
    const keys = Object.keys(body);
    if (keys.length !== 1 || !('displayed' in body)) {
      throw new AppError(400, 'validation_error', 'Invalid character update.', {
        body: 'Expected { displayed: boolean }.',
      });
    }
    if (typeof body.displayed !== 'boolean') {
      throw new AppError(400, 'validation_error', 'Invalid character update.', {
        displayed: 'Must be a boolean.',
      });
    }
    const existing = await store.getCharacterForUser(pool, s.userId, characterId);
    if (!existing || existing.stale || existing.game !== 'wow_forever') {
      throw new AppError(404, 'not_found', 'Character not found.');
    }
    const updated = await store.setCharacterDisplayed(pool, {
      userId: s.userId,
      characterId,
      displayed: body.displayed,
    });
    if (!updated) throw new AppError(404, 'not_found', 'Character not found.');
    const selection = await store.getSelection(pool, s.userId);
    return {
      character: store.characterToApi(updated),
      selection: store.selectionToApi(selection),
    };
  });

  app.post('/api/v1/me/characters/refresh', async (req, reply) => {
    requireCsrf(req);
    const s = requireSession(req);
    const last = await store.getLastRefreshedAt(pool, s.userId);
    const now = Date.now();
    if (last) {
      const retryAfter = Math.ceil((last.getTime() + REFRESH_COOLDOWN_MS - now) / 1000);
      if (retryAfter > 0) {
        reply.header('Retry-After', String(retryAfter));
        throw new AppError(429, 'rate_limited', 'Character refresh is rate-limited. Try again shortly.', undefined, {
          retryAfterSec: retryAfter,
        });
      }
    }
    await store.touchLastRefreshed(pool, s.userId);

    const user = await store.getUser(pool, s.userId);
    if (!user?.access_token) {
      // Signed-in row without a usable Blizzard token — client must re-auth.
      await store.revokeSession(pool, s.sessionId);
      clearSessionCookie(reply, config.cookieSecure);
      throw new AppError(401, 'session_expired', 'Session expired. Sign in again.');
    }
    let access: string;
    try {
      access = decryptSecret(user.access_token, config.TOKEN_ENC_KEY, {
        previousKeyHex: config.TOKEN_ENC_KEY_PREVIOUS,
      });
    } catch (err) {
      if (err instanceof TokenDecryptError) {
        req.log.warn({ user_id: s.userId, code: err.code }, 'stored blizzard token invalid; forcing re-login');
        await store.clearUserTokens(pool, s.userId);
        await store.revokeSession(pool, s.sessionId);
        clearSessionCookie(reply, config.cookieSecure);
        throw new AppError(401, 'session_expired', 'Session expired. Sign in again.');
      }
      req.log.error({ err }, 'token decrypt failed');
      throw new AppError(502, 'upstream_unavailable', 'Battle.net is not responding.');
    }
    try {
      const pulled = await blizzard.fetchForeverCharactersAll(access);
      await store.replaceCharacters(pool, s.userId, pulled);
    } catch (err) {
      const status = (err as { status?: number }).status;
      // Blizzard rejected the token — treat as expired session, not a transient upstream blip.
      if (status === 401 || status === 403) {
        req.log.warn({ user_id: s.userId, status }, 'blizzard token unauthorized; forcing re-login');
        await store.clearUserTokens(pool, s.userId);
        await store.revokeSession(pool, s.sessionId);
        clearSessionCookie(reply, config.cookieSecure);
        throw new AppError(401, 'session_expired', 'Session expired. Sign in again.');
      }
      // Never leak upstream bodies/status text to clients.
      req.log.error({ err }, 'character refresh failed');
      const retryAfterRaw = (err as { retryAfterSec?: number }).retryAfterSec;
      // Always 502 for a stable client mapping (catalog); 5xx/timeouts share this code.
      throw new AppError(502, 'upstream_unavailable', 'Battle.net is not responding.', undefined, {
        retryable: true,
        retryAfterSec: typeof retryAfterRaw === 'number' && retryAfterRaw > 0 ? retryAfterRaw : undefined,
      });
    }
    const chars = await store.listCharacters(pool, s.userId);
    const selection = await store.getSelection(pool, s.userId);
    return characterListBody(chars, selection);
  });

  app.put('/api/v1/me/characters/selection', async (req) => {
    requireCsrf(req);
    const s = requireSession(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError(400, 'validation_error', 'Invalid selection.', {
        body: 'Expected a JSON object.',
      });
    }
    const parsed = parseDisplayedIds(body);
    const chars = await store.listCharacters(pool, s.userId);
    const live = new Map(
      chars
        .filter((c) => !c.stale && c.game === 'wow_forever')
        .map((c) => [c.id, c] as const),
    );
    if (parsed.shape === 'legacy') {
      if (parsed.mainId && !live.has(parsed.mainId)) {
        throw new AppError(400, 'validation_error', 'Invalid selection.', {
          main_id: 'unknown_character',
        });
      }
      for (const id of parsed.ids) {
        if (id === parsed.mainId) continue;
        if (!live.has(id)) {
          throw new AppError(400, 'validation_error', 'Invalid selection.', {
            alt_ids: 'unknown_character',
          });
        }
      }
    } else {
      for (const id of parsed.ids) {
        if (!live.has(id)) {
          throw new AppError(400, 'validation_error', 'Invalid selection.', {
            displayed_character_ids: 'unknown_character',
          });
        }
      }
    }
    const selection = await store.setSelection(pool, {
      userId: s.userId,
      displayedCharacterIds: parsed.ids,
      mainId: parsed.mainId,
    });
    return { selection: store.selectionToApi(selection) };
  });

  // Test helper: clear Postgres refresh cooldown between cases
  app.decorate('clearRefreshCooldowns', async (userId?: string) => {
    if (userId) {
      await store.clearLastRefreshed(pool, userId);
      return;
    }
    await pool.query(`UPDATE users SET last_refreshed_at = NULL`);
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    clearRefreshCooldowns?: (userId?: string) => Promise<void>;
  }
}
