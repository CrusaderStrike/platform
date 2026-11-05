import type { FastifyInstance } from 'fastify';
import type { Pool } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { requireCsrf, requireSession } from '../auth/session.js';
import * as authStore from '../auth/store.js';
import {
  MAX_UPLOAD_BYTES,
  SERVER_SCHEMA_VERSION,
  uploadBodySchema,
  zodErrorsToFields,
} from '../uploads/schema.js';
import * as upStore from '../uploads/store.js';

export type UploadDeps = { pool: Pool };

export type RejectedRecord = {
  kind: 'dungeon_run' | 'world_pvp' | 'battleground';
  id: string;
  reason: string;
};

export async function registerUploadRoutes(app: FastifyInstance, deps: UploadDeps): Promise<void> {
  const { pool } = deps;

  app.post('/api/v1/uploads', { bodyLimit: MAX_UPLOAD_BYTES }, async (req, reply) => {
    requireCsrf(req);
    const s = requireSession(req);

    const rate = await upStore.checkUploadRateLimit(pool, s.userId);
    if (!rate.ok) {
      reply.header('Retry-After', String(rate.retryAfterSec));
      throw new AppError(429, 'rate_limited', 'Upload is rate-limited. Try again shortly.');
    }

    const rawBody = req.body;
    if (rawBody == null || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      throw new AppError(400, 'validation_error', 'Invalid upload.', { body: 'Expected a JSON object.' });
    }

    // Reject unknown envelope schema versions before full parse (clearer error).
    const ver = (rawBody as { schemaVersion?: unknown }).schemaVersion;
    if (ver !== undefined && ver !== SERVER_SCHEMA_VERSION) {
      throw new AppError(400, 'validation_error', 'Unsupported schema version.', {
        schemaVersion: `unsupported (server max ${SERVER_SCHEMA_VERSION})`,
      });
    }

    const parsed = uploadBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new AppError(400, 'validation_error', 'Invalid upload.', zodErrorsToFields(parsed.error));
    }
    const body = parsed.data;

    const selection = await authStore.getSelection(pool, s.userId);
    const selected = upStore.selectedCharacterIds(selection);
    if (!selected.has(body.characterId)) {
      throw new AppError(403, 'forbidden', 'Character is not in your selection.', {
        characterId: 'Must be your selected main or an alt.',
      });
    }
    const owned = await authStore.getCharacterForUser(pool, s.userId, body.characterId);
    if (!owned) {
      throw new AppError(403, 'forbidden', 'Character is not in your selection.', {
        characterId: 'Must be your selected main or an alt.',
      });
    }

    const guildId = await upStore.resolveUploadGuildId(pool, s.userId, s.activeGuildId);

    let accepted = 0;
    let duplicate = 0;
    const rejected: RejectedRecord[] = [];

    for (const run of body.dungeonRuns) {
      try {
        const outcome = await upStore.insertDungeonRun(pool, {
          guildId,
          userId: s.userId,
          characterId: body.characterId,
          run,
        });
        if (outcome === 'accepted') accepted += 1;
        else duplicate += 1;
      } catch (err) {
        rejected.push({
          kind: 'dungeon_run',
          id: run.addonRunId,
          reason: err instanceof Error ? err.message : 'insert_failed',
        });
      }
    }

    for (const rec of body.worldPvp) {
      try {
        const outcome = await upStore.insertWorldPvp(pool, {
          guildId,
          userId: s.userId,
          characterId: body.characterId,
          rec,
        });
        if (outcome === 'accepted') accepted += 1;
        else duplicate += 1;
      } catch (err) {
        rejected.push({
          kind: 'world_pvp',
          id: rec.addon_pvp_id,
          reason: err instanceof Error ? err.message : 'insert_failed',
        });
      }
    }

    for (const rec of body.battlegrounds) {
      try {
        const outcome = await upStore.insertBattleground(pool, {
          guildId,
          userId: s.userId,
          characterId: body.characterId,
          rec,
        });
        if (outcome === 'accepted') accepted += 1;
        else duplicate += 1;
      } catch (err) {
        rejected.push({
          kind: 'battleground',
          id: rec.addon_pvp_id,
          reason: err instanceof Error ? err.message : 'insert_failed',
        });
      }
    }

    return {
      accepted,
      duplicate,
      rejected,
      guild_id: guildId,
      character_id: body.characterId,
    };
  });

  app.decorate('clearUploadCooldowns', async (userId?: string) => {
    await upStore.clearUploadRateLimit(pool, userId);
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    clearUploadCooldowns?: (userId?: string) => Promise<void>;
  }
}
