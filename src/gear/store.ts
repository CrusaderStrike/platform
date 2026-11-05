/**
 * Gear list event log + synchronous projections (platform#17).
 * Event log is the source of truth; gear_lists / gear_list_items update in the same txn.
 */
import type { Pool, PoolClient } from '../db/pool.js';
import {
  MAX_ITEMS_PER_LIST,
  MAX_LISTS_PER_CHARACTER,
  idempotencyKeyForCreate,
  idempotencyKeyForOp,
  isAddonSideSource,
  type EventType,
  type GearOpIn,
  type GearSource,
} from './schema.js';
import {
  ensurePersonalGuild,
  resolveUploadGuildId,
  selectedCharacterIds,
  findCharacterByRealmName,
} from '../uploads/store.js';

export type Db = Pool | PoolClient;

export {
  ensurePersonalGuild,
  resolveUploadGuildId,
  selectedCharacterIds,
  findCharacterByRealmName,
};

export type GearListRow = {
  id: string;
  guild_id: string;
  character_id: string;
  owner_user_id: string;
  name: string;
  version: string; // pg bigint
  visibility: 'private' | 'guild';
  deleted_at: Date | null;
  updated_at: Date;
  updated_source: GearSource | null;
  updated_by: string | null;
};

export type GearItemRow = {
  guild_id: string;
  list_id: string;
  slot: string;
  item_id: number;
  priority: number;
  note: string | null;
  obtained: boolean;
  obtained_at: Date | null;
};

export type GearEventRow = {
  guild_id: string;
  list_id: string;
  seq: string;
  event_type: EventType;
  schema_ver: number;
  payload: Record<string, unknown>;
  source: GearSource;
  actor: string | null;
  idempotency_key: string;
  occurred_at: Date | null;
  recorded_at: Date;
};

export type ActorInfo = { user_id: string; display_name: string };

export type ConflictReason = 'superseded_by_newer_edit' | 'item_removed' | 'stale_base_version' | 'item_not_forever';

export type GearConflict = {
  op_id: string;
  reason: ConflictReason;
  winning_version?: number;
  message?: string;
};

export type ApplyOpsResult = {
  version: number;
  applied: string[];
  duplicates: string[];
  conflicts: GearConflict[];
  ignored: { op_id: string; keys: string[] }[];
};

export async function setTenant(db: Db, guildId: string): Promise<void> {
  await db.query(`SELECT set_config('app.guild_id', $1, true)`, [guildId]);
}

export async function countActiveLists(db: Db, characterId: string): Promise<number> {
  const r = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM gear_lists
     WHERE character_id = $1 AND deleted_at IS NULL`,
    [characterId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

export async function listListsForCharacter(
  db: Db,
  args: { characterId: string; viewerUserId: string },
): Promise<GearListRow[]> {
  const r = await db.query<GearListRow>(
    `SELECT * FROM gear_lists
     WHERE character_id = $1
       AND deleted_at IS NULL
       AND (owner_user_id = $2 OR visibility = 'guild')
     ORDER BY lower(name)`,
    [args.characterId, args.viewerUserId],
  );
  return r.rows;
}

export async function getList(db: Db, listId: string): Promise<GearListRow | null> {
  const r = await db.query<GearListRow>(`SELECT * FROM gear_lists WHERE id = $1`, [listId]);
  return r.rows[0] ?? null;
}

export async function getItems(db: Db, listId: string): Promise<GearItemRow[]> {
  const r = await db.query<GearItemRow>(
    `SELECT * FROM gear_list_items WHERE list_id = $1
     ORDER BY slot, priority ASC, item_id`,
    [listId],
  );
  return r.rows;
}

export function canViewList(list: GearListRow, viewerUserId: string): boolean {
  if (list.owner_user_id === viewerUserId) return true;
  if (list.visibility === 'guild' && !list.deleted_at) return true;
  return false;
}

export function canWriteList(list: GearListRow, viewerUserId: string): boolean {
  return list.owner_user_id === viewerUserId && !list.deleted_at;
}

/**
 * Append an event. Uses ON CONFLICT DO NOTHING so a 23505 never aborts the txn.
 * Callers must hold FOR UPDATE on the list row (or create under an advisory lock)
 * before choosing `seq`, so concurrent writers serialize on version.
 */
export async function appendEvent(
  db: Db,
  args: {
    guildId: string;
    listId: string;
    seq: number;
    eventType: EventType;
    payload: Record<string, unknown>;
    source: GearSource;
    actor: ActorInfo | null;
    idempotencyKey: string;
    occurredAt?: Date | null;
  },
): Promise<'inserted' | 'duplicate'> {
  const r = await db.query(
    `INSERT INTO gear_list_events (
       guild_id, list_id, seq, event_type, schema_ver, payload, source, actor,
       idempotency_key, occurred_at
     ) VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,$7,$8,$9)
     ON CONFLICT DO NOTHING
     RETURNING seq`,
    [
      args.guildId,
      args.listId,
      args.seq,
      args.eventType,
      JSON.stringify(args.payload),
      args.source,
      args.actor ? JSON.stringify(args.actor) : null,
      args.idempotencyKey,
      args.occurredAt ?? null,
    ],
  );
  return r.rowCount ? 'inserted' : 'duplicate';
}

/** Lock list row for the rest of the transaction. Returns null if missing. */
export async function lockListForUpdate(db: Db, listId: string): Promise<GearListRow | null> {
  const r = await db.query<GearListRow>(
    `SELECT * FROM gear_lists WHERE id = $1 FOR UPDATE`,
    [listId],
  );
  return r.rows[0] ?? null;
}

/** Serialize creates for one character within the transaction (5-list cap). */
export async function lockCharacterForListCreate(db: Db, characterId: string): Promise<void> {
  // hashtext → int4; advisory_xact_lock releases at COMMIT/ROLLBACK.
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [characterId]);
}

export async function createList(
  db: Db,
  args: {
    guildId: string;
    characterId: string;
    ownerUserId: string;
    name: string;
    visibility: 'private' | 'guild';
    source: GearSource;
    actor: ActorInfo;
    listId?: string;
  },
): Promise<{ list: GearListRow; created: boolean }> {
  await lockCharacterForListCreate(db, args.characterId);
  const count = await countActiveLists(db, args.characterId);
  if (count >= MAX_LISTS_PER_CHARACTER) {
    const err = new Error(LIST_LIMIT_MSG);
    (err as Error & { code: string }).code = 'list_limit_reached';
    throw err;
  }

  const listId = args.listId ?? crypto.randomUUID();
  const idem = idempotencyKeyForCreate(listId);

  const ins = await db.query<GearListRow>(
    `INSERT INTO gear_lists (
       id, guild_id, character_id, owner_user_id, name, version, visibility,
       updated_at, updated_source, updated_by
     ) VALUES ($1,$2,$3,$4,$5,1,$6, now(), $7, $8)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [
      listId,
      args.guildId,
      args.characterId,
      args.ownerUserId,
      args.name,
      args.visibility,
      args.source,
      args.actor.display_name,
    ],
  );
  if (!ins.rows[0]) {
    const existing = await getList(db, listId);
    return { list: existing!, created: false };
  }
  const list = ins.rows[0];
  const outcome = await appendEvent(db, {
    guildId: args.guildId,
    listId,
    seq: 1,
    eventType: 'GearListCreated',
    payload: {
      name: args.name,
      character_id: args.characterId,
      visibility: args.visibility,
    },
    source: args.source,
    actor: args.actor,
    idempotencyKey: idem,
  });
  if (outcome === 'duplicate') {
    const existing = await getList(db, listId);
    return { list: existing!, created: false };
  }
  return { list, created: true };
}

const LIST_LIMIT_MSG = 'list_limit_reached';

export function isListLimitError(err: unknown): boolean {
  return (err as { code?: string })?.code === 'list_limit_reached';
}

export async function patchListMeta(
  db: Db,
  args: {
    list: GearListRow;
    expectedVersion: number;
    name?: string;
    visibility?: 'private' | 'guild';
    source: GearSource;
    actor: ActorInfo;
  },
): Promise<{ ok: true; list: GearListRow } | { ok: false; reason: 'version_mismatch'; list: GearListRow }> {
  const locked = await lockListForUpdate(db, args.list.id);
  if (!locked || locked.deleted_at) {
    return { ok: false, reason: 'version_mismatch', list: args.list };
  }
  const currentVersion = Number(locked.version);
  if (currentVersion !== args.expectedVersion) {
    return { ok: false, reason: 'version_mismatch', list: locked };
  }
  const nextSeq = currentVersion + 1;
  let eventType: EventType | null = null;
  let payload: Record<string, unknown> = {};
  let name = locked.name;
  let visibility = locked.visibility;

  if (args.name !== undefined && args.name !== locked.name) {
    eventType = 'GearListRenamed';
    payload = { name: args.name };
    name = args.name;
  }
  if (args.visibility !== undefined && args.visibility !== locked.visibility) {
    // Fold visibility into GearListRenamed (with name when both change; name+visibility when visibility-only).
    if (eventType === 'GearListRenamed') {
      payload = { ...payload, visibility: args.visibility };
    } else {
      eventType = 'GearListRenamed';
      payload = { name: locked.name, visibility: args.visibility };
    }
    visibility = args.visibility;
  }
  if (!eventType) {
    return { ok: true, list: locked };
  }

  const outcome = await appendEvent(db, {
    guildId: locked.guild_id,
    listId: locked.id,
    seq: nextSeq,
    eventType,
    payload,
    source: args.source,
    actor: args.actor,
    idempotencyKey: `meta:${locked.id}:${nextSeq}:${args.actor.user_id}`,
  });
  if (outcome === 'duplicate') {
    const fresh = await getList(db, locked.id);
    return { ok: false, reason: 'version_mismatch', list: fresh! };
  }

  const upd = await db.query<GearListRow>(
    `UPDATE gear_lists
     SET name = $2, visibility = $3, version = $4,
         updated_at = now(), updated_source = $5, updated_by = $6
     WHERE id = $1 AND version = $7
     RETURNING *`,
    [
      locked.id,
      name,
      visibility,
      nextSeq,
      args.source,
      args.actor.display_name,
      args.expectedVersion,
    ],
  );
  if (!upd.rows[0]) {
    const fresh = await getList(db, args.list.id);
    return { ok: false, reason: 'version_mismatch', list: fresh! };
  }
  return { ok: true, list: upd.rows[0] };
}

export async function deleteList(
  db: Db,
  args: {
    list: GearListRow;
    expectedVersion: number;
    source: GearSource;
    actor: ActorInfo;
  },
): Promise<{ ok: true; list: GearListRow } | { ok: false; reason: 'version_mismatch'; list: GearListRow }> {
  const locked = await lockListForUpdate(db, args.list.id);
  if (!locked || locked.deleted_at) {
    return { ok: false, reason: 'version_mismatch', list: args.list };
  }
  const currentVersion = Number(locked.version);
  if (currentVersion !== args.expectedVersion) {
    return { ok: false, reason: 'version_mismatch', list: locked };
  }
  const nextSeq = currentVersion + 1;
  const outcome = await appendEvent(db, {
    guildId: locked.guild_id,
    listId: locked.id,
    seq: nextSeq,
    eventType: 'GearListDeleted',
    payload: {},
    source: args.source,
    actor: args.actor,
    idempotencyKey: `delete:${locked.id}:${nextSeq}`,
  });
  if (outcome === 'duplicate') {
    const fresh = await getList(db, locked.id);
    return { ok: false, reason: 'version_mismatch', list: fresh! };
  }
  const upd = await db.query<GearListRow>(
    `UPDATE gear_lists
     SET deleted_at = now(), version = $2,
         updated_at = now(), updated_source = $3, updated_by = $4
     WHERE id = $1 AND version = $5 AND deleted_at IS NULL
     RETURNING *`,
    [locked.id, nextSeq, args.source, args.actor.display_name, args.expectedVersion],
  );
  if (!upd.rows[0]) {
    const fresh = await getList(db, locked.id);
    return { ok: false, reason: 'version_mismatch', list: fresh! };
  }
  return { ok: true, list: upd.rows[0] };
}

function itemKey(slot: string, itemId: number): string {
  return `${slot}:${itemId}`;
}

/** Latest seq that touched (slot,item_id), excluding GearOpRejected. */
async function lastItemTouchSeq(
  db: Db,
  listId: string,
  slot: string,
  itemId: number,
): Promise<number> {
  const r = await db.query<{ seq: string }>(
    `SELECT seq FROM gear_list_events
     WHERE list_id = $1
       AND event_type IN (
         'GearItemAdded','GearItemRemoved','GearItemReprioritized','GearItemObtained'
       )
       AND (payload->>'slot') = $2
       AND (payload->>'item_id')::int = $3
     ORDER BY seq DESC
     LIMIT 1`,
    [listId, slot, itemId],
  );
  return r.rows[0] ? Number(r.rows[0].seq) : 0;
}

export async function applyOps(
  db: Db,
  args: {
    list: GearListRow;
    ops: GearOpIn[];
    defaultSource: GearSource;
    actor: ActorInfo;
    ignored?: { op_id: string; keys: string[] }[];
    /** When true, Forever catalog check runs (stub: always pass until catalog exists). */
    foreverCheck?: (itemId: number) => boolean;
  },
): Promise<ApplyOpsResult> {
  const applied: string[] = [];
  const duplicates: string[] = [];
  const conflicts: GearConflict[] = [];
  // Source is always server-derived; never trust client op.source (web/system rejected at route).
  const source = args.defaultSource;
  const foreverCheck = args.foreverCheck ?? (() => true);

  const locked = await lockListForUpdate(db, args.list.id);
  if (!locked || locked.deleted_at) {
    return {
      version: Number(args.list.version),
      applied,
      duplicates,
      conflicts: args.ops.map((op) => ({
        op_id: op.op_id,
        reason: 'item_removed' as ConflictReason,
        message: 'List not found or deleted.',
      })),
      ignored: args.ignored ?? [],
    };
  }
  let list = locked;
  let version = Number(list.version);

  for (const op of args.ops) {
    const idem = idempotencyKeyForOp(op.op_id);

    // Idempotent retry
    const prior = await db.query(
      `SELECT 1 FROM gear_list_events WHERE guild_id = $1 AND idempotency_key = $2`,
      [list.guild_id, idem],
    );
    if (prior.rowCount) {
      duplicates.push(op.op_id);
      continue;
    }

    if (!foreverCheck(op.item_id)) {
      // Forever reject still consumes a seq + bumps list.version so later writes don't collide.
      version += 1;
      await appendEvent(db, {
        guildId: list.guild_id,
        listId: list.id,
        seq: version,
        eventType: 'GearOpRejected',
        payload: { op_id: op.op_id, reason: 'item_not_forever', item_id: op.item_id },
        source,
        actor: args.actor,
        idempotencyKey: idem,
        occurredAt: op.client_ts ? new Date(op.client_ts) : null,
      });
      conflicts.push({
        op_id: op.op_id,
        reason: 'item_not_forever',
        message: 'item_not_forever',
      });
      await bumpListVersion(db, list.id, version, source, args.actor.display_name);
      list = (await getList(db, list.id))!;
      continue;
    }

    const items = await getItems(db, list.id);
    const existing = items.find((i) => i.slot === op.slot && i.item_id === op.item_id);
    const lastTouch = await lastItemTouchSeq(db, list.id, op.slot, op.item_id);

    // Stale base_version when the same item was touched after client's base
    if (lastTouch > op.base_version) {
      const reason: ConflictReason =
        !existing && op.type !== 'add_item' ? 'item_removed' : 'stale_base_version';
      // Web beats stale addon-side when base is behind
      if (isAddonSideSource(source) || reason === 'stale_base_version') {
        version += 1;
        await appendEvent(db, {
          guildId: list.guild_id,
          listId: list.id,
          seq: version,
          eventType: 'GearOpRejected',
          payload: {
            op_id: op.op_id,
            reason,
            winning_seq: lastTouch,
            slot: op.slot,
            item_id: op.item_id,
          },
          source,
          actor: args.actor,
          idempotencyKey: idem,
          occurredAt: op.client_ts ? new Date(op.client_ts) : null,
        });
        conflicts.push({
          op_id: op.op_id,
          reason,
          winning_version: lastTouch,
          message: reason === 'item_removed' ? 'Item was removed on the server.' : 'Stale base_version.',
        });
        await bumpListVersion(db, list.id, version, source, args.actor.display_name);
        list = (await getList(db, list.id))!;
        continue;
      }
    }

    // Missing remove: single bucket (applied) — idempotent no-op with event for retry.
    if (op.type === 'remove_item' && !existing) {
      version += 1;
      await appendEvent(db, {
        guildId: list.guild_id,
        listId: list.id,
        seq: version,
        eventType: 'GearItemRemoved',
        payload: { slot: op.slot, item_id: op.item_id },
        source,
        actor: args.actor,
        idempotencyKey: idem,
        occurredAt: op.client_ts ? new Date(op.client_ts) : null,
      });
      await bumpListVersion(db, list.id, version, source, args.actor.display_name);
      applied.push(op.op_id);
      list = (await getList(db, list.id))!;
      continue;
    }

    if (op.type === 'add_item') {
      if (items.length >= MAX_ITEMS_PER_LIST && !existing) {
        version += 1;
        await appendEvent(db, {
          guildId: list.guild_id,
          listId: list.id,
          seq: version,
          eventType: 'GearOpRejected',
          payload: { op_id: op.op_id, reason: 'list_items_limit', slot: op.slot, item_id: op.item_id },
          source,
          actor: args.actor,
          idempotencyKey: idem,
          occurredAt: op.client_ts ? new Date(op.client_ts) : null,
        });
        conflicts.push({
          op_id: op.op_id,
          reason: 'superseded_by_newer_edit',
          message: 'list_items_limit',
        });
        await bumpListVersion(db, list.id, version, source, args.actor.display_name);
        list = (await getList(db, list.id))!;
        continue;
      }
      version += 1;
      const note = op.note ?? null;
      await appendEvent(db, {
        guildId: list.guild_id,
        listId: list.id,
        seq: version,
        eventType: 'GearItemAdded',
        payload: {
          slot: op.slot,
          item_id: op.item_id,
          priority: op.priority,
          note,
        },
        source,
        actor: args.actor,
        idempotencyKey: idem,
        occurredAt: op.client_ts ? new Date(op.client_ts) : null,
      });
      // Re-add resets obtained + note to match rebuildFromLog (GearItemAdded clears obtained).
      await db.query(
        `INSERT INTO gear_list_items (guild_id, list_id, slot, item_id, priority, note, obtained, obtained_at)
         VALUES ($1,$2,$3,$4,$5,$6,false,NULL)
         ON CONFLICT (list_id, slot, item_id) DO UPDATE
           SET priority = EXCLUDED.priority,
               note = EXCLUDED.note,
               obtained = false,
               obtained_at = NULL`,
        [list.guild_id, list.id, op.slot, op.item_id, op.priority!, note],
      );
      await bumpListVersion(db, list.id, version, source, args.actor.display_name);
      applied.push(op.op_id);
      list = (await getList(db, list.id))!;
      continue;
    }

    if (op.type === 'remove_item') {
      version += 1;
      await appendEvent(db, {
        guildId: list.guild_id,
        listId: list.id,
        seq: version,
        eventType: 'GearItemRemoved',
        payload: { slot: op.slot, item_id: op.item_id },
        source,
        actor: args.actor,
        idempotencyKey: idem,
        occurredAt: op.client_ts ? new Date(op.client_ts) : null,
      });
      await db.query(
        `DELETE FROM gear_list_items WHERE list_id = $1 AND slot = $2 AND item_id = $3`,
        [list.id, op.slot, op.item_id],
      );
      await bumpListVersion(db, list.id, version, source, args.actor.display_name);
      applied.push(op.op_id);
      list = (await getList(db, list.id))!;
      continue;
    }

    if (op.type === 'reprioritize_item') {
      if (!existing) {
        version += 1;
        await appendEvent(db, {
          guildId: list.guild_id,
          listId: list.id,
          seq: version,
          eventType: 'GearOpRejected',
          payload: { op_id: op.op_id, reason: 'item_removed', slot: op.slot, item_id: op.item_id },
          source,
          actor: args.actor,
          idempotencyKey: idem,
          occurredAt: op.client_ts ? new Date(op.client_ts) : null,
        });
        conflicts.push({
          op_id: op.op_id,
          reason: 'item_removed',
          message: 'Item not on list.',
        });
        await bumpListVersion(db, list.id, version, source, args.actor.display_name);
        list = (await getList(db, list.id))!;
        continue;
      }
      version += 1;
      await appendEvent(db, {
        guildId: list.guild_id,
        listId: list.id,
        seq: version,
        eventType: 'GearItemReprioritized',
        payload: {
          slot: op.slot,
          item_id: op.item_id,
          priority: op.priority,
          from_priority: existing.priority,
        },
        source,
        actor: args.actor,
        idempotencyKey: idem,
        occurredAt: op.client_ts ? new Date(op.client_ts) : null,
      });
      await db.query(
        `UPDATE gear_list_items SET priority = $4
         WHERE list_id = $1 AND slot = $2 AND item_id = $3`,
        [list.id, op.slot, op.item_id, op.priority!],
      );
      await bumpListVersion(db, list.id, version, source, args.actor.display_name);
      applied.push(op.op_id);
      list = (await getList(db, list.id))!;
      continue;
    }

    if (op.type === 'mark_obtained') {
      if (!existing && op.obtained !== false) {
        version += 1;
        await appendEvent(db, {
          guildId: list.guild_id,
          listId: list.id,
          seq: version,
          eventType: 'GearOpRejected',
          payload: { op_id: op.op_id, reason: 'item_removed', slot: op.slot, item_id: op.item_id },
          source,
          actor: args.actor,
          idempotencyKey: idem,
          occurredAt: op.client_ts ? new Date(op.client_ts) : null,
        });
        conflicts.push({
          op_id: op.op_id,
          reason: 'item_removed',
          message: 'Item not on list.',
        });
        await bumpListVersion(db, list.id, version, source, args.actor.display_name);
        list = (await getList(db, list.id))!;
        continue;
      }
      const obtained = op.obtained !== false;
      version += 1;
      await appendEvent(db, {
        guildId: list.guild_id,
        listId: list.id,
        seq: version,
        eventType: 'GearItemObtained',
        payload: {
          slot: op.slot,
          item_id: op.item_id,
          obtained,
          run_id: op.run_id ?? null,
        },
        source,
        actor: args.actor,
        idempotencyKey: idem,
        occurredAt: op.client_ts ? new Date(op.client_ts) : null,
      });
      if (existing) {
        await db.query(
          `UPDATE gear_list_items
           SET obtained = $4, obtained_at = CASE WHEN $4 THEN now() ELSE NULL END
           WHERE list_id = $1 AND slot = $2 AND item_id = $3`,
          [list.id, op.slot, op.item_id, obtained],
        );
      }
      await bumpListVersion(db, list.id, version, source, args.actor.display_name);
      applied.push(op.op_id);
      list = (await getList(db, list.id))!;
      continue;
    }
  }

  return {
    version: Number((await getList(db, args.list.id))!.version),
    applied,
    duplicates,
    conflicts,
    ignored: args.ignored ?? [],
  };
}

async function bumpListVersion(
  db: Db,
  listId: string,
  version: number,
  source: GearSource,
  updatedBy: string,
): Promise<void> {
  await db.query(
    `UPDATE gear_lists
     SET version = $2, updated_at = now(), updated_source = $3, updated_by = $4
     WHERE id = $1`,
    [listId, version, source, updatedBy],
  );
}

export async function listEvents(
  db: Db,
  args: { listId: string; afterVersion?: number; limit: number },
): Promise<GearEventRow[]> {
  const after = args.afterVersion ?? 0;
  const r = await db.query<GearEventRow>(
    `SELECT * FROM gear_list_events
     WHERE list_id = $1 AND seq > $2
     ORDER BY seq ASC
     LIMIT $3`,
    [args.listId, after, args.limit],
  );
  return r.rows;
}

/**
 * Rebuild projection for a list from its event log. Returns items + meta version/name/visibility.
 * Used by tests (and ops tooling) to prove log ≡ read tables.
 */
export async function rebuildFromLog(
  db: Db,
  listId: string,
): Promise<{
  name: string;
  visibility: 'private' | 'guild';
  version: number;
  deleted: boolean;
  items: Map<string, { slot: string; item_id: number; priority: number; note: string | null; obtained: boolean }>;
}> {
  const events = await db.query<GearEventRow>(
    `SELECT * FROM gear_list_events WHERE list_id = $1 ORDER BY seq ASC`,
    [listId],
  );
  let name = '';
  let visibility: 'private' | 'guild' = 'private';
  let version = 0;
  let deleted = false;
  const items = new Map<
    string,
    { slot: string; item_id: number; priority: number; note: string | null; obtained: boolean }
  >();

  for (const ev of events.rows) {
    version = Number(ev.seq);
    const payload = ev.payload;
    switch (ev.event_type) {
      case 'GearListCreated':
        name = String(payload.name ?? '');
        visibility = (payload.visibility as 'private' | 'guild') ?? 'private';
        break;
      case 'GearListRenamed':
        if (payload.name != null) name = String(payload.name);
        if (payload.visibility === 'private' || payload.visibility === 'guild') {
          visibility = payload.visibility;
        }
        break;
      case 'GearListDeleted':
        deleted = true;
        break;
      case 'GearItemAdded': {
        const slot = String(payload.slot);
        const item_id = Number(payload.item_id);
        items.set(itemKey(slot, item_id), {
          slot,
          item_id,
          priority: Number(payload.priority),
          note: (payload.note as string | null) ?? null,
          obtained: false,
        });
        break;
      }
      case 'GearItemRemoved': {
        const slot = String(payload.slot);
        const item_id = Number(payload.item_id);
        items.delete(itemKey(slot, item_id));
        break;
      }
      case 'GearItemReprioritized': {
        const slot = String(payload.slot);
        const item_id = Number(payload.item_id);
        const cur = items.get(itemKey(slot, item_id));
        if (cur) cur.priority = Number(payload.priority);
        break;
      }
      case 'GearItemObtained': {
        const slot = String(payload.slot);
        const item_id = Number(payload.item_id);
        const cur = items.get(itemKey(slot, item_id));
        if (cur) cur.obtained = Boolean(payload.obtained);
        break;
      }
      case 'GearOpRejected':
        break;
    }
  }
  return { name, visibility, version, deleted, items };
}

export function etagForVersion(version: number | string): string {
  return `"v${version}"`;
}

export function parseIfMatchVersion(header: string | string | undefined): number | null {
  if (!header || typeof header !== 'string') return null;
  const m = header.trim().match(/^"v(\d+)"$/);
  if (!m) return null;
  return Number(m[1]);
}

export function serializeList(
  list: GearListRow,
  items: GearItemRow[],
): Record<string, unknown> {
  return {
    id: list.id,
    character_id: list.character_id,
    owner_user_id: list.owner_user_id,
    name: list.name,
    visibility: list.visibility,
    version: Number(list.version),
    updated_at: list.updated_at.toISOString(),
    updated_source: list.updated_source,
    items: items.map((i) => ({
      slot: i.slot,
      item_id: i.item_id,
      priority: i.priority,
      note: i.note,
      obtained: i.obtained,
      obtained_at: i.obtained_at ? i.obtained_at.toISOString() : null,
      icon_url: null,
    })),
  };
}

export function serializeEvent(ev: GearEventRow): Record<string, unknown> {
  let actor: ActorInfo | string | null = null;
  if (ev.actor) {
    try {
      actor = JSON.parse(ev.actor) as ActorInfo;
    } catch {
      actor = { user_id: ev.actor, display_name: ev.actor };
    }
  }
  return {
    version: Number(ev.seq),
    event_type: ev.event_type,
    payload: ev.payload,
    actor,
    source: ev.source,
    op_id: typeof ev.payload?.op_id === 'string' ? ev.payload.op_id : null,
    recorded_at: ev.recorded_at.toISOString(),
  };
}

/** Max gear writes per user per rolling 60s window (no minimum interval between writes). */
export const GEAR_WRITE_LIMIT_PER_MIN = 60;
export const GEAR_WRITE_WINDOW_MS = 60_000;

export async function checkGearWriteRateLimit(
  db: Db,
  userId: string,
): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
  const row = await db.query<{ window_start: Date; write_count: number }>(
    `SELECT window_start, write_count FROM gear_write_rate_limits WHERE user_id = $1`,
    [userId],
  );
  const cur = row.rows[0];
  if (!cur) return { ok: true };
  const elapsed = Date.now() - cur.window_start.getTime();
  if (elapsed >= GEAR_WRITE_WINDOW_MS) return { ok: true };
  if (cur.write_count < GEAR_WRITE_LIMIT_PER_MIN) return { ok: true };
  const retryAfter = Math.max(1, Math.ceil((GEAR_WRITE_WINDOW_MS - elapsed) / 1000));
  return { ok: false, retryAfterSec: retryAfter };
}

/** Record one successful gear write against the rolling 60/min bucket. */
export async function touchGearWriteRateLimit(db: Db, userId: string): Promise<void> {
  await db.query(
    `INSERT INTO gear_write_rate_limits (user_id, window_start, write_count)
     VALUES ($1, now(), 1)
     ON CONFLICT (user_id) DO UPDATE SET
       window_start = CASE
         WHEN gear_write_rate_limits.window_start <= now() - interval '60 seconds'
           THEN now()
         ELSE gear_write_rate_limits.window_start
       END,
       write_count = CASE
         WHEN gear_write_rate_limits.window_start <= now() - interval '60 seconds'
           THEN 1
         ELSE gear_write_rate_limits.write_count + 1
       END`,
    [userId],
  );
}

export async function clearGearWriteRateLimit(db: Db, userId?: string): Promise<void> {
  if (userId) {
    await db.query(`DELETE FROM gear_write_rate_limits WHERE user_id = $1`, [userId]);
  } else {
    await db.query(`DELETE FROM gear_write_rate_limits`);
  }
}
