import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { requireCsrf, requireSession } from '../auth/session.js';
import * as authStore from '../auth/store.js';
import {
  GEAR_SLOTS,
  MAX_LIST_NAME,
  MAX_OPS_PER_REQUEST,
  MAX_SYNC_BYTES,
  type GearSlot,
  parseOp,
  parseSyncBody,
  type GearSource,
} from '../gear/schema.js';
import * as gear from '../gear/store.js';
import {
  parseRoleSpec,
  parseSetType,
  validateSetLevelRules,
} from '../gear/set-meta.js';
import * as foreverItems from '../items/store.js';
import { scheduleWritePathNoopPrune } from '../gear/noop-retention.js';

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

/** Character ids are opaque TEXT (not UUIDs); reject empty / oversized / control chars. */
function requireCharacterId(id: string): void {
  if (!id || id.length > 128 || /[\u0000-\u001f]/.test(id)) {
    throw new AppError(400, 'validation_error', 'Invalid character_id.', {
      character_id: 'Required, max 128 chars, no control characters.',
    });
  }
}

/**
 * Display set (#41): hidden / unselected characters → 409 character_not_displayed.
 */
function requireDisplayedCharacter(
  selection: { displayed_character_ids: string[] } | null,
  characterId: string,
): void {
  const selected = gear.selectedCharacterIds(selection);
  if (!selected.has(characterId)) {
    // No fields — clients key off error.code character_not_displayed.
    throw new AppError(409, 'character_not_displayed', 'Character is not in your display set.');
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

/** Slot PUT: If-Match optional. Missing → null (last-write-wins). Present but bad → 400. */
function optionalIfMatch(req: FastifyRequest): number | null {
  const raw = req.headers['if-match'];
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
    return null;
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
  // Atomic consume before the write (~60/min). A later failed write still spends the token.
  const rate = await gear.consumeGearWrite(pool, userId);
  if (!rate.ok) {
    reply.header('Retry-After', String(rate.retryAfterSec));
    throw new AppError(429, 'rate_limited', 'Gear write is rate-limited. Try again shortly.', undefined, {
      retryAfterSec: rate.retryAfterSec,
    });
  }
}


async function assertForeverSlotItem(
  db: Parameters<typeof foreverItems.catalogIsActive>[0],
  itemId: number,
  slot: GearSlot,
): Promise<void> {
  const active = await foreverItems.catalogIsActive(db);
  if (!active) return;
  const row = await foreverItems.getItem(db, itemId);
  if (!row) {
    throw new AppError(400, 'validation_error', 'Item is not in the Forever catalog.', {
      item_id: 'item_not_forever',
    });
  }
  const aliases = row.slot_aliases ?? [];
  if (row.slot !== slot && !aliases.includes(slot)) {
    throw new AppError(400, 'validation_error', 'Item does not fit this equipment slot.', {
      item_id: 'item_not_in_slot',
    });
  }
}

/**
 * Shared Forever + slot-fit predicates for applyOps (/ops and /sync).
 * One catalog getItem per (itemId) call site: foreverCheck caches the row so fitsSlot
 * does not re-read when set_slot runs both checks.
 */
function foreverSlotChecks(
  db: Parameters<typeof foreverItems.catalogIsActive>[0],
  catalogActive: boolean,
): {
  foreverCheck: (itemId: number) => Promise<boolean>;
  fitsSlot: (itemId: number, slot: string) => Promise<boolean>;
} {
  const cache = new Map<number, Awaited<ReturnType<typeof foreverItems.getItem>> | undefined>();
  async function load(itemId: number) {
    if (!catalogActive) return null;
    if (cache.has(itemId)) return cache.get(itemId) ?? null;
    const row = await foreverItems.getItem(db, itemId);
    cache.set(itemId, row);
    return row;
  }
  return {
    foreverCheck: async (itemId) => {
      if (!catalogActive) return true;
      return (await load(itemId)) != null;
    },
    fitsSlot: async (itemId, slot) => {
      if (!catalogActive) return true;
      const row = await load(itemId);
      if (!row) return true; // foreverCheck owns missing-item (runs first for set_slot)
      const aliases = row.slot_aliases ?? [];
      return row.slot === slot || aliases.includes(slot);
    },
  };
}

function parseSlotsMap(raw: unknown): Record<string, number | null> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError(400, 'validation_error', 'Invalid slots.', {
      slots: 'Must be an object map of slot → item_id|null.',
    });
  }
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(GEAR_SLOTS as readonly string[]).includes(k)) {
      throw new AppError(400, 'validation_error', `Unknown slot: ${k}.`, {
        slot: 'invalid_slot',
      });
    }
    if (v === null) {
      out[k] = null;
      continue;
    }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      throw new AppError(400, 'validation_error', 'Invalid slots.', {
        [k]: 'item_id must be a positive integer or null.',
      });
    }
    out[k] = v;
  }
  return out;
}

export async function registerGearListRoutes(
  app: FastifyInstance,
  deps: GearListDeps,
): Promise<void> {
  const { pool } = deps;

  app.get('/api/v1/characters/:character_id/gear-lists', async (req) => {
    const s = requireSession(req);
    const characterId = (req.params as { character_id: string }).character_id;
    requireCharacterId(characterId);
    const owned = await authStore.getCharacterForUser(pool, s.userId, characterId);
    if (!owned) throw new AppError(404, 'not_found', 'Character not found.');
    const selection = await authStore.getSelection(pool, s.userId);
    requireDisplayedCharacter(selection, characterId);

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
        itemsOut.push(
          gear.serializeList(list, items, { characterLevel: owned.level }),
        );
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
    requireCharacterId(characterId);
    await requireGearWriteRate(pool, reply, s.userId);
    const owned = await authStore.getCharacterForUser(pool, s.userId, characterId);
    if (!owned) throw new AppError(404, 'not_found', 'Character not found.');
    const selection = await authStore.getSelection(pool, s.userId);
    requireDisplayedCharacter(selection, characterId);

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.name !== 'string') {
      throw new AppError(400, 'validation_error', 'Invalid list.', { name: 'Required.' });
    }
    const name = body.name.trim();
    if (!name || name.length > MAX_LIST_NAME || /[\u0000-\u001f]/.test(name)) {
      throw new AppError(400, 'validation_error', 'Invalid list.', {
        name: `1..${MAX_LIST_NAME} chars, no control characters.`,
      });
    }
    const typeParsed = parseSetType(body.type);
    if (!typeParsed.ok) {
      throw new AppError(400, 'validation_error', 'Invalid list.', { type: typeParsed.detail });
    }
    const levelFields = validateSetLevelRules(typeParsed.value, body.until_level, owned.level);
    if (levelFields) {
      throw new AppError(400, 'validation_error', 'Invalid list.', levelFields);
    }
    const untilLevel =
      typeParsed.value === 'max_level'
        ? null
        : (body.until_level as number);
    const roleParsed = parseRoleSpec(body.role_spec);
    if (!roleParsed.ok) {
      throw new AppError(400, 'validation_error', 'Invalid list.', { role_spec: roleParsed.detail });
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
    const slots = parseSlotsMap(body.slots);

    const guildId = await gear.resolveUploadGuildId(pool, s.userId, s.activeGuildId);
    const battletag = await loadBattletag(pool, s.userId);
    const actor = actorFromUser(s.userId, battletag);

    if (slots) {
      for (const [slot, itemId] of Object.entries(slots)) {
        if (itemId != null) {
          await assertForeverSlotItem(pool, itemId, slot as GearSlot);
        }
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await gear.setTenant(client, guildId);
      // Server-derived source: web session routes always record `web`.
      let { list } = await gear.createList(client, {
        guildId,
        characterId,
        ownerUserId: s.userId,
        name,
        visibility,
        setType: typeParsed.value,
        untilLevel,
        roleSpec: roleParsed.value,
        source: 'web',
        actor,
      });
      if (slots) {
        for (const [slot, itemId] of Object.entries(slots)) {
          if (itemId == null) continue;
          const applied = await gear.setListSlot(client, {
            list,
            expectedVersion: Number(list.version),
            slot: slot as GearSlot,
            itemId,
            source: 'web',
            actor,
          });
          if (!applied.ok) {
            throw new AppError(409, 'version_mismatch', 'List was modified; reload and retry.');
          }
          list = applied.list;
        }
      }
      await client.query('COMMIT');
      const items = await gear.getItems(pool, list.id);
      const serialized = gear.serializeList(list, items, { characterLevel: owned.level });
      reply.header('ETag', gear.etagForVersion(list.version));
      return reply.code(201).send(serialized);
    } catch (err) {
      await client.query('ROLLBACK');
      if (gear.isListLimitError(err)) {
        throw new AppError(409, 'list_limit_reached', 'Maximum of 20 gear lists per character.');
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
      const owned = await authStore.getCharacterForUser(pool, s.userId, list.character_id);
      reply.header('ETag', gear.etagForVersion(list.version));
      return gear.serializeList(list, items, {
        characterLevel: owned?.level ?? null,
      });
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
    const body = (req.body ?? {}) as Record<string, unknown>;
    let name: string | undefined;
    let visibility: 'private' | 'guild' | undefined;
    let setType: import('../gear/schema.js').GearSetType | undefined;
    let untilLevel: number | null | undefined;
    let roleSpec: string | null | undefined;
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
    if (body.type !== undefined) {
      const parsed = parseSetType(body.type);
      if (!parsed.ok) {
        throw new AppError(400, 'validation_error', 'Invalid list.', { type: parsed.detail });
      }
      setType = parsed.value;
    }
    if (body.until_level !== undefined) {
      untilLevel = body.until_level as number | null;
    }
    if (body.role_spec !== undefined) {
      const parsed = parseRoleSpec(body.role_spec);
      if (!parsed.ok) {
        throw new AppError(400, 'validation_error', 'Invalid list.', { role_spec: parsed.detail });
      }
      roleSpec = parsed.value;
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
      const selection = await authStore.getSelection(pool, s.userId);
      requireDisplayedCharacter(selection, list.character_id);
      const owned = await authStore.getCharacterForUser(pool, s.userId, list.character_id);
      const nextType = setType ?? list.set_type;
      const nextUntil =
        untilLevel !== undefined
          ? untilLevel
          : setType !== undefined && setType === 'max_level'
            ? null
            : list.until_level;
      if (setType !== undefined || untilLevel !== undefined) {
        const levelFields = validateSetLevelRules(nextType, nextUntil, owned?.level ?? null);
        if (levelFields) {
          throw new AppError(400, 'validation_error', 'Invalid list.', levelFields);
        }
      }
      const result = await gear.patchListMeta(client, {
        list,
        expectedVersion: expected,
        name,
        visibility,
        setType,
        untilLevel: setType === 'max_level' ? null : untilLevel,
        roleSpec,
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
            retryable: true,
            request_id: req.id,
          },
          current: {
            version: Number(result.list.version),
            list: gear.serializeList(result.list, items, {
              characterLevel: owned?.level ?? null,
            }),
          },
        });
      }
      const items = await gear.getItems(client, result.list.id);
      await client.query('COMMIT');
      reply.header('ETag', gear.etagForVersion(result.list.version));
      return gear.serializeList(result.list, items, {
        characterLevel: owned?.level ?? null,
      });
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
      const selection = await authStore.getSelection(pool, s.userId);
      requireDisplayedCharacter(selection, list.character_id);
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
            retryable: true,
            request_id: req.id,
          },
          current: {
            version: Number(result.list.version),
            list: gear.serializeList(result.list, items),
          },
        });
      }
      await client.query('COMMIT');
      return reply.code(204).send();
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });


  app.put('/api/v1/gear-lists/:list_id/slots/:slot', async (req, reply) => {
    requireCsrf(req);
    const s = requireSession(req);
    const params = req.params as { list_id: string; slot: string };
    requireUuid(params.list_id, 'list_id');
    if (!(GEAR_SLOTS as readonly string[]).includes(params.slot)) {
      throw new AppError(400, 'validation_error', 'Unknown equipment slot.', {
        slot: 'invalid_slot',
      });
    }
    const slot = params.slot as GearSlot;
    await requireGearWriteRate(pool, reply, s.userId);
    const expected = optionalIfMatch(req);
    const body = (req.body ?? {}) as { item_id?: unknown };
    if (!('item_id' in body)) {
      throw new AppError(400, 'validation_error', 'Invalid slot update.', {
        item_id: 'Required (number or null).',
      });
    }
    let itemId: number | null;
    if (body.item_id === null) {
      itemId = null;
    } else if (typeof body.item_id === 'number' && Number.isInteger(body.item_id) && body.item_id >= 1) {
      itemId = body.item_id;
    } else {
      throw new AppError(400, 'validation_error', 'Invalid slot update.', {
        item_id: 'Must be a positive integer or null.',
      });
    }

    const guildId = await gear.resolveUploadGuildId(pool, s.userId, s.activeGuildId);
    const battletag = await loadBattletag(pool, s.userId);
    const actor = actorFromUser(s.userId, battletag);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await gear.setTenant(client, guildId);
      const list = await gear.getList(client, params.list_id);
      if (!list || list.deleted_at) throw new AppError(404, 'not_found', 'List not found.');
      if (!gear.canWriteList(list, s.userId)) {
        throw new AppError(404, 'not_found', 'List not found.');
      }
      // Ownership of the list's character before display-set gate.
      const owned = await authStore.getCharacterForUser(client, s.userId, list.character_id);
      if (!owned) throw new AppError(404, 'not_found', 'Character not found.');
      const selection = await authStore.getSelection(client, s.userId);
      requireDisplayedCharacter(selection, list.character_id);
      if (itemId != null) {
        await assertForeverSlotItem(client, itemId, slot);
      }
      const result = await gear.setListSlot(client, {
        list,
        expectedVersion: expected,
        slot,
        itemId,
        source: 'web',
        actor,
      });
      if (!result.ok) {
        await client.query('COMMIT');
        return reply.code(409).send({
          error: {
            code: 'version_mismatch',
            message: 'List was modified; reload and retry.',
            retryable: true,
            request_id: req.id,
          },
          current: { version: Number(result.list.version) },
        });
      }
      await client.query('COMMIT');
      reply.header('ETag', gear.etagForVersion(result.list.version));
      return {
        slot,
        item_id: itemId,
        edited_at: result.list.updated_at.toISOString(),
        version: Number(result.list.version),
      };
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
      // Re-check character still in display set at write time.
      const selection = await authStore.getSelection(pool, s.userId);
      requireDisplayedCharacter(selection, list.character_id);

      const catalogActive = await foreverItems.catalogIsActive(client);
      const checks = foreverSlotChecks(client, catalogActive);
      const result = await gear.applyOps(client, {
        list,
        ops,
        defaultSource: 'web',
        actor,
        ignored,
        foreverCheck: checks.foreverCheck,
        fitsSlot: checks.fitsSlot,
      });
      const fresh = await gear.getList(client, listId);
      const items = await gear.getItems(client, listId);
      await client.query('COMMIT');
      // After COMMIT only — prune must never abort the write txn (platform#47 / #48 review).
      scheduleWritePathNoopPrune(pool);
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
      requireCharacterId(envelope.characterId);
      owned = await authStore.getCharacterForUser(pool, s.userId, envelope.characterId);
      if (!owned) throw new AppError(404, 'not_found', 'Character not found.');
      if (!selected.has(envelope.characterId)) {
        throw new AppError(409, 'character_not_displayed', 'Character is not in your display set.');
      }
    } else if (envelope.realm && envelope.name) {
      owned = await gear.findCharacterByRealmName(
        pool,
        s.userId,
        envelope.realm,
        envelope.name,
      );
      if (!owned) throw new AppError(404, 'not_found', 'Character not found.');
      if (!selected.has(owned.id)) {
        throw new AppError(409, 'character_not_displayed', 'Character is not in your display set.');
      }
    }
    if (!owned) {
      throw new AppError(404, 'not_found', 'Character not found.');
    }

    const guildId = await gear.resolveUploadGuildId(pool, s.userId, s.activeGuildId);
    const battletag = await loadBattletag(pool, s.userId);
    const actor = actorFromUser(s.userId, battletag);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await gear.setTenant(client, guildId);
      const gearResults = [];
      // Sort by list_id so concurrent /sync never deadlock on lock order.
      const sortedLists = [...envelope.lists].sort((a, b) =>
        a.list_id < b.list_id ? -1 : a.list_id > b.list_id ? 1 : 0,
      );
      for (const entry of sortedLists) {
        const sp = `sp_sync_${entry.list_id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)}`;
        await client.query(`SAVEPOINT ${sp}`);
        try {
          const list = await gear.getList(client, entry.list_id);
          if (!list || list.deleted_at || list.character_id !== owned.id) {
            await client.query(`RELEASE SAVEPOINT ${sp}`);
            gearResults.push({
              list_id: entry.list_id,
              error: { code: 'not_found', message: 'List not found for character.', retryable: false },
            });
            continue;
          }
          if (!gear.canWriteList(list, s.userId)) {
            await client.query(`RELEASE SAVEPOINT ${sp}`);
            gearResults.push({
              list_id: entry.list_id,
              error: { code: 'forbidden', message: 'Only the list owner can sync edits.', retryable: false },
            });
            continue;
          }

          const catalogActive = await foreverItems.catalogIsActive(client);
          const checks = foreverSlotChecks(client, catalogActive);
          const result = await gear.applyOps(client, {
            list,
            ops: entry.ops,
            defaultSource: envelope.source,
            actor,
            ignored: entry.ignored,
            foreverCheck: checks.foreverCheck,
            fitsSlot: checks.fitsSlot,
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
          // Log detail server-side; never leak raw Postgres / driver text to clients.
          req.log.error({ err, list_id: entry.list_id }, 'gear sync list failed');
          gearResults.push({
            list_id: entry.list_id,
            error: {
              code: 'internal_error',
              message: 'List sync failed.',
              retryable: true,
            },
          });
        }
      }
      await client.query('COMMIT');
      // After COMMIT only — prune must never abort the write txn (platform#47 / #48 review).
      scheduleWritePathNoopPrune(pool);
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

  if (process.env.NODE_ENV === 'test') {
    app.decorate('clearGearWriteCooldowns', async (userId?: string) => {
      await gear.clearGearWriteRateLimit(pool, userId);
    });
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    clearGearWriteCooldowns?: (userId?: string) => Promise<void>;
  }
}
