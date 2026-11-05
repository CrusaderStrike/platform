import type { FastifyInstance } from 'fastify';
import type { Pool } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { requireCsrf, requireSession } from '../auth/session.js';
import * as authStore from '../auth/store.js';
import {
  MAX_UPLOAD_BYTES,
  SERVER_SCHEMA_VERSION,
  matchesCharacter,
  parseUploadBody,
  pvpIdPrefix,
  type IgnoredKey,
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

    const rawBody = req.body;
    if (rawBody == null || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      throw new AppError(400, 'validation_error', 'Invalid upload.', { body: 'Expected a JSON object.' });
    }

    const ver = (rawBody as { schemaVersion?: unknown }).schemaVersion;
    if (ver !== undefined && ver !== SERVER_SCHEMA_VERSION) {
      throw new AppError(400, 'validation_error', 'Unsupported schema version.', {
        schemaVersion: `unsupported (server max ${SERVER_SCHEMA_VERSION})`,
      });
    }

    const parsed = parseUploadBody(rawBody);
    if (!('dungeonRuns' in parsed) || Object.keys(parsed.fieldErrors).length) {
      throw new AppError(
        400,
        'validation_error',
        'Invalid upload.',
        'fieldErrors' in parsed ? parsed.fieldErrors : { body: 'Invalid upload.' },
      );
    }

    const selection = await authStore.getSelection(pool, s.userId);
    const selected = upStore.selectedCharacterIds(selection);

    let owned: { id: string; character_name: string; realm: string | null } | null = null;
    if (parsed.characterId) {
      if (!selected.has(parsed.characterId)) {
        throw new AppError(403, 'forbidden', 'Character is not in your selection.', {
          characterId: 'Must be your selected main or an alt.',
        });
      }
      owned = await authStore.getCharacterForUser(pool, s.userId, parsed.characterId);
    } else if (parsed.realm && parsed.name) {
      owned = await upStore.findCharacterByRealmName(pool, s.userId, parsed.realm, parsed.name);
      if (owned && !selected.has(owned.id)) {
        throw new AppError(403, 'forbidden', 'Character is not in your selection.', {
          characterId: 'Must be your selected main or an alt.',
        });
      }
    }
    if (!owned) {
      throw new AppError(403, 'forbidden', 'Character is not in your selection.', {
        characterId: 'Must be your selected main or an alt.',
      });
    }
    const characterId = owned.id;

    const rate = await upStore.checkUploadRateLimit(pool, s.userId);
    if (!rate.ok) {
      reply.header('Retry-After', String(rate.retryAfterSec));
      throw new AppError(429, 'rate_limited', 'Upload is rate-limited. Try again shortly.');
    }

    const guildId = await upStore.resolveUploadGuildId(pool, s.userId, s.activeGuildId);

    let accepted = 0;
    let duplicate = 0;
    const rejected: RejectedRecord[] = [];
    const ignored: IgnoredKey[] = [];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      /** Isolate each record so one DB error does not abort later inserts or fake an accept. */
      async function withSavepoint<T>(label: string, fn: () => Promise<T>): Promise<T> {
        const sp = `sp_${label.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40)}`;
        await client.query(`SAVEPOINT ${sp}`);
        try {
          const result = await fn();
          await client.query(`RELEASE SAVEPOINT ${sp}`);
          return result;
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          throw err;
        }
      }

      for (const { record: run, ignored: keys } of parsed.dungeonRuns) {
        if (keys.length) {
          ignored.push({ kind: 'dungeon_run', id: run.addonRunId, keys });
        }
        if (!matchesCharacter(owned, run.realm, run.character)) {
          rejected.push({ kind: 'dungeon_run', id: run.addonRunId, reason: 'character_mismatch' });
          continue;
        }
        try {
          const outcome = await withSavepoint('dungeon_run', () =>
            upStore.upsertDungeonRun(client, {
              guildId,
              userId: s.userId,
              characterId,
              run,
            }),
          );
          if (outcome === 'accepted') accepted += 1;
          else duplicate += 1;
        } catch (err) {
          req.log.error({ err, addonRunId: run.addonRunId }, 'dungeon_run insert failed');
          rejected.push({ kind: 'dungeon_run', id: run.addonRunId, reason: 'insert_failed' });
        }
      }

      for (const { record: rec, ignored: keys } of parsed.worldPvp) {
        if (keys.length) {
          ignored.push({ kind: 'world_pvp', id: rec.addon_pvp_id, keys });
        }
        const prefix = pvpIdPrefix(rec.addon_pvp_id);
        if (!prefix || !matchesCharacter(owned, prefix.realm, prefix.character)) {
          rejected.push({ kind: 'world_pvp', id: rec.addon_pvp_id, reason: 'character_mismatch' });
          continue;
        }
        try {
          const outcome = await withSavepoint('world_pvp', () =>
            upStore.insertWorldPvp(client, {
              guildId,
              userId: s.userId,
              characterId,
              rec,
            }),
          );
          if (outcome === 'accepted') accepted += 1;
          else duplicate += 1;
        } catch (err) {
          req.log.error({ err, addonPvpId: rec.addon_pvp_id }, 'world_pvp insert failed');
          rejected.push({ kind: 'world_pvp', id: rec.addon_pvp_id, reason: 'insert_failed' });
        }
      }

      for (const { record: rec, ignored: keys } of parsed.battlegrounds) {
        if (keys.length) {
          ignored.push({ kind: 'battleground', id: rec.addon_pvp_id, keys });
        }
        const prefix = pvpIdPrefix(rec.addon_pvp_id);
        if (!prefix || !matchesCharacter(owned, prefix.realm, prefix.character)) {
          rejected.push({ kind: 'battleground', id: rec.addon_pvp_id, reason: 'character_mismatch' });
          continue;
        }
        try {
          const outcome = await withSavepoint('battleground', () =>
            upStore.insertBattleground(client, {
              guildId,
              userId: s.userId,
              characterId,
              rec,
            }),
          );
          if (outcome === 'accepted') accepted += 1;
          else duplicate += 1;
        } catch (err) {
          req.log.error({ err, addonPvpId: rec.addon_pvp_id }, 'battleground insert failed');
          rejected.push({ kind: 'battleground', id: rec.addon_pvp_id, reason: 'insert_failed' });
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Burn cooldown only when the batch produced a successful accept or duplicate (not pure rejects / 4xx).
    if (accepted + duplicate > 0) {
      await upStore.touchUploadRateLimit(pool, s.userId);
    }

    return {
      accepted,
      duplicate,
      rejected,
      ignored,
      guild_id: guildId,
      character_id: characterId,
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
