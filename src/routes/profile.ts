import type { FastifyInstance } from 'fastify';
import type { Pool } from '../db/pool.js';
import type { BlizzardClient } from '../blizzard/client.js';
import { AppError } from '../lib/errors.js';
import * as store from '../auth/store.js';
import { requireCsrf, requireSession } from '../auth/session.js';

const REFRESH_COOLDOWN_MS = 60_000;
const lastRefresh = new Map<string, number>();

export type ProfileDeps = {
  pool: Pool;
  blizzard: BlizzardClient;
};

function characterListBody(
  chars: store.CharacterRow[],
  selection: store.SelectionRow | null,
) {
  return {
    game: 'wow_forever' as const,
    characters: chars.map(store.characterToApi),
    selection: store.selectionToApi(selection),
  };
}

export async function registerProfileRoutes(app: FastifyInstance, deps: ProfileDeps): Promise<void> {
  const { pool, blizzard } = deps;

  app.get('/api/v1/me/profile', async (req) => {
    const s = requireSession(req);
    const user = await store.getUser(pool, s.userId);
    if (!user) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    const selection = await store.getSelection(pool, s.userId);
    return {
      battletag: user.battletag,
      main_character_id: selection?.main_id ?? null,
      preferred_region: user.preferred_region,
      created_at: user.created_at.toISOString(),
      updated_at: user.updated_at.toISOString(),
    };
  });

  app.put('/api/v1/me/profile', async (req) => {
    requireCsrf(req);
    const s = requireSession(req);
    const body = (req.body ?? {}) as { preferred_region?: string };
    if (body.preferred_region !== undefined) {
      if (body.preferred_region !== 'us' && body.preferred_region !== 'eu') {
        throw new AppError(400, 'validation_error', 'Invalid preferred_region.', {
          preferred_region: 'Must be us or eu.',
        });
      }
      await store.updatePreferredRegion(pool, s.userId, body.preferred_region);
    }
    const user = await store.getUser(pool, s.userId);
    if (!user) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    const selection = await store.getSelection(pool, s.userId);
    return {
      battletag: user.battletag,
      main_character_id: selection?.main_id ?? null,
      preferred_region: user.preferred_region,
      created_at: user.created_at.toISOString(),
      updated_at: user.updated_at.toISOString(),
    };
  });

  app.get('/api/v1/me/characters', async (req) => {
    const s = requireSession(req);
    const chars = await store.listCharacters(pool, s.userId);
    const selection = await store.getSelection(pool, s.userId);
    return characterListBody(chars, selection);
  });

  app.post('/api/v1/me/characters/refresh', async (req, reply) => {
    requireCsrf(req);
    const s = requireSession(req);
    const now = Date.now();
    const prev = lastRefresh.get(s.userId) ?? 0;
    const retryAfter = Math.ceil((prev + REFRESH_COOLDOWN_MS - now) / 1000);
    if (retryAfter > 0) {
      reply.header('Retry-After', String(retryAfter));
      throw new AppError(429, 'rate_limited', 'Character refresh is rate-limited. Try again shortly.');
    }
    lastRefresh.set(s.userId, now);

    const user = await store.getUser(pool, s.userId);
    if (!user?.access_token) {
      throw new AppError(502, 'upstream_unavailable', 'Battle.net is not responding.');
    }
    try {
      const pulled = await blizzard.fetchForeverCharacters(user.access_token, user.preferred_region);
      await store.replaceCharacters(pool, s.userId, pulled);
    } catch (err) {
      req.log.error({ err }, 'character refresh failed');
      // Allow retry sooner on hard upstream failure by not counting? Spec: still rate-limit attempts.
      throw new AppError(502, 'upstream_unavailable', 'Battle.net is not responding.');
    }
    const chars = await store.listCharacters(pool, s.userId);
    const selection = await store.getSelection(pool, s.userId);
    return characterListBody(chars, selection);
  });

  app.put('/api/v1/me/characters/selection', async (req) => {
    requireCsrf(req);
    const s = requireSession(req);
    const body = req.body as { main_id?: string; alt_ids?: string[] };
    if (!body || typeof body.main_id !== 'string') {
      throw new AppError(400, 'validation_error', 'Invalid selection.', {
        main_id: 'Pick a main from your characters.',
      });
    }
    const altIds = Array.isArray(body.alt_ids) ? body.alt_ids : null;
    if (!altIds) {
      throw new AppError(400, 'validation_error', 'Invalid selection.', {
        alt_ids: 'alt_ids must be an array.',
      });
    }
    const chars = await store.listCharacters(pool, s.userId);
    const live = new Set(chars.filter((c) => !c.stale).map((c) => c.id));
    if (!live.has(body.main_id)) {
      throw new AppError(400, 'validation_error', 'Invalid selection.', {
        main_id: 'Pick a main from your characters.',
      });
    }
    const seen = new Set<string>();
    for (const id of altIds) {
      if (typeof id !== 'string' || !live.has(id) || id === body.main_id || seen.has(id)) {
        throw new AppError(400, 'validation_error', 'Invalid selection.', {
          alt_ids: 'Alts must be your other characters.',
        });
      }
      seen.add(id);
    }
    const selection = await store.setSelection(pool, {
      userId: s.userId,
      mainId: body.main_id,
      altIds,
    });
    return { selection: store.selectionToApi(selection) };
  });

  // Test helper: clear in-memory refresh cooldown between cases
  app.decorate('clearRefreshCooldowns', () => lastRefresh.clear());
}

declare module 'fastify' {
  interface FastifyInstance {
    clearRefreshCooldowns?: () => void;
  }
}
