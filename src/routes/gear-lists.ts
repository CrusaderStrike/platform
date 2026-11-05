import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { requireCsrf, requireSession } from '../auth/session.js';
import * as authStore from '../auth/store.js';
import * as upStore from '../uploads/store.js';
import {
  MAX_LIST_NAME,
  MAX_OPS_PER_REQUEST,
  MAX_SYNC_BYTES,
  parseOp,
  parseSyncBody,
  type GearSource,
} from '../gear/schema.js';
import * as gear from '../gear/store.js';

export type GearListDeps = { pool: Pool };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Sync feeders may send addon|companion|export only. Never web|system from clients. */
const SYNC_SOURCES = new Set<GearSource>(['addon', 'companion', 'export']);

function actorFromUser(userId: string, battletag: string): gear.ActorInfo {
  return { user_id: userId, display_name: battletag };
}

async function loadBattletag(pool: Pool, userId: string): Promise<string> {
  const r = await pool.query<{ battletag: string }>(
    `SELECT battletag FROM users WHERE id = $1`,
    [userId],
  );
  return r.rows[0]?.battletag ?? userId;
}

function requireUuid(id: string, field: string): void {
  if (!UUID_RE.test(id)) {
    throw new AppError(400, 'validation_error', `Invalid ${field}.`, {
      [field]: 'Must be a UUID.',
    });
  }
}

function requireOwnedCharacter(
  selection: { main_id: string; alt_ids: string[] } | null,
  characterId: string,
): void {
  const selected = gear.selectedCharacterIds(selection);
  if (!selected.has(characterId)) {
    throw new AppError(403, 'forbidden', 'Character is not in your selection.', {
      character_id: 'Must be your selected main or an alt.',
    });
  }
}

function requireIfMatch(req: FastifyRequest): number {
  const raw = req.headers['if-match'];
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
    // No fields → error handler emits { error: { code: precondition_required } }.
    throw new AppError(428, 'precondition_required', 'If-Match required.');
  }
  const expected = gear.parseIfMatchVersion(typeof raw === 'string' ? raw : raw[0]);
  if (expected == null) {
    throw new AppError(400, 'validation_error', 'Invalid If-Match.', {
      'If-Match': 'Expected ETag like "v12".',
    });
  }
  return expected;
}

async function requireGearWriteRate(
  pool: Pool,
  reply: FastifyReply,
  userId: string,
): Promise<void> {
  // Basic write rate limit (same 5s window as uploads). Separate gear bucket/tuning → follow-up.
  const rate = await upStore.checkUploadRateLimit(pool, userId);
  if (!rate.ok) {
    reply.header('Retry-After', String(rate.retryAfterSec));
    throw new AppError(429, 'rate_limited', 'Gear write is rate-limited. Try again shortly.');
  }
}

export async function registerGearListRoutes(
  app: FastifyInstance,
  deps: GearListDeps,
): Promise<void> {
  const { pool } = deps;

  app.get('/api/v1/characters/:character_id/gear-lists', async (req) => {
    const s = requireSession(req);
    const characterId = (req.params as { character_id: string }).character_id;
    const selection = await authStore.getSelection(pool, s.userId);
    requireOwnedCharacter(selection, characterId);
    const owned = await authStore.getCharacterForUser(pool, s.userId, characterId);
    if (!owned) throw new AppError(404, 'not_found', 'Character not found.');

    const guildId = await gear.resolveUploadGuildId(pool, s.userId, s.activeGuildId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await gear.setTenant(client, guildId);
      const lists = await gear.listListsForCharacter(client, {
        characterId,
        viewerUserId: s.userId,
      });
      const itemsOut = [];
      for (const list of lists) {
        const items = await gear.getItems(client, list.id);
        itemsOut.push(gear.serializeList(list, items));
      }
      await client.query('COMMIT');
      return { items: itemsOut };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  app.post('/api/v1/characters/:character_id/gear-lists', async (req, reply) => {
    requireCsrf(req);
    const s = requireSession(req);
    const characterId = (req.params as { character_id: string }).character_id;
    await requireGearWriteRate(pool, reply, s.userId);
    const selection = await authStore.getSelection(pool, s.userId);
    requireOwnedCharacter(selection, characterId);
    const owned = await authStore.getCharacterForUser(pool, s.userId, characterId);
    if (!owned) throw new AppError(404, 'not_found', 'Character not found.');

    const body = (req.body ?? {}) as { name?: unknown; visibility?: unknown };
    if (typeof body.name !== 'string') {
      throw new AppError(400, 'validation_error', 'Invalid list.', { name: 'Required.' });
    }
    const name = body.name.trim();
    if (!name || name.length > MAX_LIST_NAME || /[\u0000-\u001f]/.test(name)) {
      throw new AppError(400, 'validation_error', 'Invalid list.', {
        name: `1..${MAX_LIST_NAME} chars, no control characters.`,
      });
    }
    let visibility: 'private' | 'guild' = 'private';
    if (body.visibility !== undefined) {
      if (body.visibility !== 'private' && body.visibility !== 'guild') {
        throw new AppError(400, 'validation_error', 'Invalid list.', {
          visibility: 'Must be private or guild.',
        });
      }
      visibility = body.visibility;
    }

    const guildId = await gear.resolveUploadGuildId(pool, s.userId, s.activeGuildId);
    const battletag = await loadBattletag(pool, s.userId);
    const actor = actorFromUser(s.userId, battletag);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await gear.setTenant(client, guildId);
      // Server-derived source: web session routes always record `web`.
      const { list } = await gear.createList(client, {
        guildId,
        characterId,
        ownerUserId: s.userId,
        name,
        visibility,
        source: 'web',
        actor,
      });
      await client.query('COMMIT');
      await upStore.touchUploadRateLimit(pool, s.userId);
      const items = await gear.getItems(pool, list.id);
      const serialized = gear.serializeList(list, items);
      reply.header('ETag', gear.etagForVersion(list.version));
      return reply.code(201).send(serialized);
    } catch (err) {
      await client.query('ROLLBACK');
      if (gear.isListLimitError(err)) {
        throw new AppError(409, 'list_limit_reached', 'Maximum of 5 gear lists per character.');
      }
      throw err;
    } finally {
      client.release();
    }
  });

  app.get('/api/v1/gear-lists/:list_id', async (req, reply) => {
    const s = requireSession(req);
    const listId = (req.params as { list_id: string }).list_id;
    requireUuid(listId, 'list_id');
    const guildId = await gear.resolveUploadGuildId(pool, s.userId, s.activeGuildId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await gear.setTenant(client, guildId);
      const list = await gear.getList(client, listId);
      if (!list || list.deleted_at) throw new AppError(404, 'not_found', 'List not found.');
      if (!gear.canViewList(list, s.userId)) {
        throw new AppError(403, 'forbidden', 'Not allowed to view this list.');
      }
      const items = await gear.getItems(client, list.id);
      await client.query('COMMIT');
      reply.header('ETag', gear.etagForVersion(list.version));
      return gear.serializeList(list, items);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  app.patch('/api/v1/gear-lists/:list_id', async (req, reply) => {
    requireCsrf(req);
    const s = requireSession(req);
    const listId = (req.params as { list_id: string }).list_id;
    requireUuid(listId, 'list_id');
    await requireGearWriteRate(pool, reply, s.userId);
    const expected = requireIfMatch(req);
    const body = (req.body ?? {}) as { name?: unknown; visibility?: unknown };
    let name: string | undefined;
    let visibility: 'private' | 'guild' | undefined;
    if (body.name !== undefined) {
      if (typeof body.name !== 'string') {
        throw new AppError(400, 'validation_error', 'Invalid list.', { name: 'Must be a string.' });
      }
      name = body.name.trim();
      if (!name || name.length > MAX_LIST_NAME) {
        throw new AppError(400, 'validation_error', 'Invalid list.', { name: 'Invalid name.' });
      }
    }
    if (body.visibility !== undefined) {
      if (body.visibility !== 'private' && body.visibility !== 'guild') {
        throw new AppError(400, 'validation_error', 'Invalid list.', {
          visibility: 'Must be private or guild.',
        });
      }
      visibility = body.visibility;
    }

    const guildId = await gear.resolveUploadGuildId(pool, s.userId, s.activeGuildId);
    const battletag = await loadBattletag(pool, s.userId);
    const actor = actorFromUser(s.userId, battletag);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await gear.setTenant(client, guildId);
      const list = await gear.getList(client, listId);
      if (!list || list.deleted_at) throw new AppError(404, 'not_found', 'List not found.');
      if (!gear.canWriteList(list, s.userId)) {
        throw new AppError(403, 'forbidden', 'Only the list owner can edit.');
      }
      const result = await gear.patchListMeta(client, {
        list,
        expectedVersion: expected,
        name,
        visibility,
        source: 'web',
        actor,
      });
      if (!result.ok) {
        const items = await gear.getItems(client, result.list.id);
        await client.query('COMMIT');
        return reply.code(409).send({
          error: {
            code: 'version_mismatch',
            message: 'List was modified; reload and retry.',
            request_id: req.id,
          },
          current: {
            version: Number(result.list.version),
            list: gear.serializeList(result.list, items),
          },
        });
      }
      const items = await gear.getItems(client, result.list.id);
      await client.query('COMMIT');
      await upStore.touchUploadRateLimit(pool, s.userId);
      reply.header('ETag', gear.etagForVersion(result.list.version));
      return gear.serializeList(result.list, items);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  app.delete('/api/v1/gear-lists/:list_id', async (req, reply) => {
    requireCsrf(req);
    const s = requireSession(req);
    const listId = (req.params as { list_id: string }).list_id;
    requireUuid(listId, 'list_id');
    await requireGearWriteRate(pool, reply, s.userId);
    const expected = requireIfMatch(req);
    const guildId = await gear.resolveUploadGuildId(pool, s.userId, s.activeGuildId);
    const battletag = await loadBattletag(pool, s.userId);
    const actor = actorFromUser(s.userId, battletag);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await gear.setTenant(client, guildId);
      const list = await gear.getList(client, listId);
      if (!list || list.deleted_at) throw new AppError(404, 'not_found', 'List not found.');
      if (!gear.canWriteList(list, s.userId)) {
        throw new AppError(403, 'forbidden', 'Only the list owner can delete.');
      }
      const result = await gear.deleteList(client, {
        list,
        expectedVersion: expected,
        source: 'web',
        actor,
      });
      if (!result.ok) {
        const items = await gear.getItems(client, result.list.id);
        await client.query('COMMIT');
        return reply.code(409).send({
          error: {
            code: 'version_mismatch',
            message: 'List was modified; reload and retry.',
            request_id: req.id,
          },
          current: {
            version: Number(result.list.version),
            list: gear.serializeList(result.list, items),
          },
        });
      }
      await client.query('COMMIT');
      await upStore.touchUploadRateLimit(pool, s.userId);
      return reply.code(204).send();
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  app.post('/api/v1/gear-lists/:list_id/ops', async (req, reply) => {
    requireCsrf(req);
    const s = requireSession(req);
    const listId = (req.params as { list_id: string }).list_id;
    requireUuid(listId, 'list_id');
    await requireGearWriteRate(pool, reply, s.userId);
    const body = (req.body ?? {}) as { ops?: unknown; source?: unknown };
    if (!Array.isArray(body.ops) || body.ops.length < 1 || body.ops.length > MAX_OPS_PER_REQUEST) {
      throw new AppError(400, 'validation_error', 'Invalid ops.', {
        ops: `Array of 1..${MAX_OPS_PER_REQUEST} ops required.`,
      });
    }
    const ops: import('../gear/schema.js').GearOpIn[] = [];
    const ignored: { op_id: string; keys: string[] }[] = [];
    for (let i = 0; i < body.ops.length; i++) {
      const p = parseOp(body.ops[i]);
      if (!p.ok) {
        throw new AppError(400, 'validation_error', 'Invalid op.', {
          [`ops.${i}`]: Object.values(p.errors)[0] ?? 'Invalid.',
        });
      }
      ops.push(p.op);
      if (p.ignored.length) ignored.push({ op_id: p.op.op_id, keys: p.ignored });
    }
    // Web session route: source is always server-derived `web`. Client source is ignored.

    const guildId = await gear.resolveUploadGuildId(pool, s.userId, s.activeGuildId);
    const battletag = await loadBattletag(pool, s.userId);
    const actor = actorFromUser(s.userId, battletag);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await gear.setTenant(client, guildId);
      const list = await gear.getList(client, listId);
      if (!list || list.deleted_at) throw new AppError(404, 'not_found', 'List not found.');
      if (!gear.canWriteList(list, s.userId)) {
        throw new AppError(403, 'forbidden', 'Only the list owner can edit.');
      }
      // Re-check character still in main/alt selection at write time.
      const selection = await authStore.getSelection(pool, s.userId);
      requireOwnedCharacter(selection, list.character_id);

      const result = await gear.applyOps(client, {
        list,
        ops,
        defaultSource: 'web',
        actor,
        ignored,
      });
      const fresh = await gear.getList(client, listId);
      const items = await gear.getItems(client, listId);
      await client.query('COMMIT');
      await upStore.touchUploadRateLimit(pool, s.userId);
      return {
        version: result.version,
        applied: result.applied,
        duplicates: result.duplicates,
        conflicts: result.conflicts,
        ignored: result.ignored,
        list: gear.serializeList(fresh!, items),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      if (err instanceof AppError) throw err;
      throw err;
    } finally {
      client.release();
    }
  });

  app.get('/api/v1/gear-lists/:list_id/events', async (req) => {
    const s = requireSession(req);
    const listId = (req.params as { list_id: string }).list_id;
    requireUuid(listId, 'list_id');
    const q = req.query as { after_version?: string; limit?: string };
    const afterVersion = q.after_version != null ? Number(q.after_version) : 0;
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 25) || 25));
    if (!Number.isFinite(afterVersion) || afterVersion < 0) {
      throw new AppError(400, 'validation_error', 'Invalid after_version.', {
        after_version: 'Must be >= 0.',
      });
    }

    const guildId = await gear.resolveUploadGuildId(pool, s.userId, s.activeGuildId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await gear.setTenant(client, guildId);
      const list = await gear.getList(client, listId);
      if (!list || list.deleted_at) throw new AppError(404, 'not_found', 'List not found.');
      if (!gear.canViewList(list, s.userId)) {
        throw new AppError(403, 'forbidden', 'Not allowed to view this list history.');
      }
      const events = await gear.listEvents(client, { listId, afterVersion, limit });
      await client.query('COMMIT');
      return {
        items: events.map(gear.serializeEvent),
        next_cursor: events.length === limit ? String(events[events.length - 1]!.seq) : null,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  app.get('/api/v1/items/search', async () => {
    throw new AppError(
      501,
      'not_implemented',
      'Forever item search is not available yet.',
    );
  });

  app.post('/api/v1/sync', { bodyLimit: MAX_SYNC_BYTES }, async (req, reply) => {
    requireCsrf(req);
    const s = requireSession(req);
    await requireGearWriteRate(pool, reply, s.userId);
    const parsed = parseSyncBody(req.body);
    if (!parsed.ok) {
      throw new AppError(400, 'validation_error', 'Invalid sync payload.', parsed.fieldErrors);
    }
    const envelope = parsed.value;
    if (!SYNC_SOURCES.has(envelope.source)) {
      throw new AppError(400, 'validation_error', 'Invalid sync payload.', {
        source: 'Must be addon, companion, or export (web/system are not accepted from clients).',
      });
    }
    const selection = await authStore.getSelection(pool, s.userId);
    const selected = gear.selectedCharacterIds(selection);

    let owned: { id: string; character_name: string; realm: string | null } | null = null;
    if (envelope.characterId) {
      if (!selected.has(envelope.characterId)) {
        throw new AppError(403, 'forbidden', 'Character is not in your selection.');
      }
      owned = await authStore.getCharacterForUser(pool, s.userId, envelope.characterId);
    } else if (envelope.realm && envelope.name) {
      owned = await gear.findCharacterByRealmName(
        pool,
        s.userId,
        envelope.realm,
        envelope.name,
      );
      if (owned && !selected.has(owned.id)) {
        throw new AppError(403, 'forbidden', 'Character is not in your selection.');
      }
    }
    if (!owned) {
      throw new AppError(403, 'forbidden', 'Character is not in your selection.');
    }

    const guildId = await gear.resolveUploadGuildId(pool, s.userId, s.activeGuildId);
    const battletag = await loadBattletag(pool, s.userId);
    const actor = actorFromUser(s.userId, battletag);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await gear.setTenant(client, guildId);
      const gearResults = [];
      for (const entry of envelope.lists) {
        const sp = `sp_sync_${entry.list_id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)}`;
        await client.query(`SAVEPOINT ${sp}`);
        try {
          const list = await gear.getList(client, entry.list_id);
          if (!list || list.deleted_at || list.character_id !== owned.id) {
            await client.query(`RELEASE SAVEPOINT ${sp}`);
            gearResults.push({
              list_id: entry.list_id,
              error: { code: 'not_found', message: 'List not found for character.' },
            });
            continue;
          }
          if (!gear.canWriteList(list, s.userId)) {
            await client.query(`RELEASE SAVEPOINT ${sp}`);
            gearResults.push({
              list_id: entry.list_id,
              error: { code: 'forbidden', message: 'Only the list owner can sync edits.' },
            });
            continue;
          }

          const result = await gear.applyOps(client, {
            list,
            ops: entry.ops,
            defaultSource: envelope.source,
            actor,
            ignored: entry.ignored,
          });
          const events = await gear.listEvents(client, {
            listId: list.id,
            afterVersion: entry.since_version,
            limit: 500,
          });
          const fresh = await gear.getList(client, list.id);
          const items = await gear.getItems(client, list.id);
          await client.query(`RELEASE SAVEPOINT ${sp}`);
          gearResults.push({
            list_id: list.id,
            result: {
              version: result.version,
              applied: result.applied,
              duplicates: result.duplicates,
              conflicts: result.conflicts,
              list: gear.serializeList(fresh!, items),
            },
            events: events.map(gear.serializeEvent),
          });
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          const message = err instanceof Error ? err.message : 'List sync failed.';
          gearResults.push({
            list_id: entry.list_id,
            error: { code: 'internal_error', message },
          });
        }
      }
      await client.query('COMMIT');
      await upStore.touchUploadRateLimit(pool, s.userId);
      return {
        character_id: owned.id,
        source: envelope.source,
        runs: [],
        gear: gearResults,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}
