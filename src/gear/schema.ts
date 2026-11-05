/**
 * Gear list ops + sync envelope (platform#17).
 * Envelope is strict; unknown keys on individual ops are soft-ignored (uploads convention).
 * Sync path is agnostic across addon|companion|export (same op shape).
 * Source is server-derived: web routes force `web`; /sync accepts addon|companion|export only.
 * Op `source` is soft-ignored; clients never set web|system on /sync.
 */
import { z } from 'zod';
import { normalizeRealm, normalizeRealmSql } from '../uploads/schema.js';

export { normalizeRealm, normalizeRealmSql };

export const GEAR_SCHEMA_VERSION = 1;
export const MAX_LISTS_PER_CHARACTER = 20;
export const MAX_OPS_PER_REQUEST = 200;
/** Cap on sum of ops across all lists in one /sync body. */
export const MAX_SYNC_TOTAL_OPS = 500;
export const MAX_SYNC_BYTES = 1_048_576;
export const MAX_LIST_NAME = 64;
export const MAX_NOTE = 200;
export const MAX_ITEMS_PER_LIST = 100;
export const MAX_PRIORITY = 50;
/** HTTP 409 when creating a 21st active list for a character. */
export const LIST_LIMIT_CODE = 'list_limit_reached';
/** HTTP 422 when item_id is not Forever loot (catalog check). */
export const ITEM_NOT_FOREVER_CODE = 'item_not_forever';

export const GEAR_SLOTS = [
  'head', 'neck', 'shoulder', 'back', 'chest', 'shirt', 'tabard', 'wrist', 'hands',
  'waist', 'legs', 'feet', 'finger1', 'finger2', 'trinket1', 'trinket2',
  'main_hand', 'off_hand', 'ranged', 'ammo',
] as const;
export type GearSlot = (typeof GEAR_SLOTS)[number];

export const GEAR_SOURCES = ['web', 'addon', 'companion', 'export', 'system'] as const;
export type GearSource = (typeof GEAR_SOURCES)[number];
/** Client-facing /sync sources only. web and system are never accepted from clients. */
export const SYNC_SOURCES = ['addon', 'companion', 'export'] as const;
export type SyncSource = (typeof SYNC_SOURCES)[number];

/** Addon-side channels for conflict "stale base loses to web". */
export function isAddonSideSource(source: GearSource): boolean {
  return source === 'addon' || source === 'companion' || source === 'export';
}

export const OP_TYPES = [
  'add_item',
  'remove_item',
  'reprioritize_item',
  'mark_obtained',
  'set_slot',
  'clear_slot',
] as const;
export type OpType = (typeof OP_TYPES)[number];

export type EventType =
  | 'GearListCreated'
  | 'GearListRenamed'
  | 'GearListDeleted'
  | 'GearListMetaChanged'
  | 'GearItemAdded'
  | 'GearItemRemoved'
  | 'GearItemReprioritized'
  | 'GearItemObtained'
  | 'GearSlotSet'
  | 'GearSlotCleared'
  | 'GearOpRejected';

export const GEAR_SET_TYPES = ['leveling', 'max_level'] as const;
export type GearSetType = (typeof GEAR_SET_TYPES)[number];
export const MAX_ROLE_SPEC = 32;

const OP_KEYS = new Set([
  'op_id',
  'list_id',
  'type',
  'slot',
  'item_id',
  'priority',
  'note',
  'obtained',
  'run_id',
  'base_version',
  'client_ts',
  // `source` is intentionally NOT listed — soft-ignored; server derives source.
]);

const ENVELOPE_KEYS = new Set([
  'schemaVersion',
  'source',
  'characterId',
  'realm',
  'name',
  'lists',
  'since_version',
  'ops',
]);

export type IgnoredOpKey = { op_id: string; keys: string[] };

function stripObject(
  raw: Record<string, unknown>,
  allowed: Set<string>,
): { value: Record<string, unknown>; ignored: string[] } {
  const value: Record<string, unknown> = {};
  const ignored: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (allowed.has(k)) value[k] = v;
    else ignored.push(k);
  }
  return { value, ignored };
}

const uuid = z.string().uuid();
const slotSchema = z.enum(GEAR_SLOTS);
export const sourceSchema = z.enum(GEAR_SOURCES);

const opBodySchema = z
  .object({
    op_id: uuid,
    list_id: uuid.optional(),
    type: z.enum(OP_TYPES),
    slot: slotSchema,
    item_id: z.number().int().positive().optional(),
    priority: z.number().int().min(1).max(MAX_PRIORITY).optional(),
    note: z.string().max(MAX_NOTE).optional(),
    obtained: z.boolean().optional(),
    run_id: z.string().uuid().nullable().optional(),
    base_version: z.number().int().min(0),
    client_ts: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine((op, ctx) => {
    const needsItem =
      op.type === 'add_item' ||
      op.type === 'remove_item' ||
      op.type === 'reprioritize_item' ||
      op.type === 'mark_obtained' ||
      op.type === 'set_slot';
    if (needsItem && op.item_id == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'item_id required', path: ['item_id'] });
    }
    if (op.type === 'add_item' || op.type === 'reprioritize_item') {
      if (op.priority == null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'priority required', path: ['priority'] });
      }
    }
    if (op.type === 'mark_obtained' && op.obtained === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'obtained required', path: ['obtained'] });
    }
  });

export type GearOpIn = z.infer<typeof opBodySchema>;

export function stripOp(raw: unknown): { op: Record<string, unknown>; ignored: string[] } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const stripped = stripObject(raw as Record<string, unknown>, OP_KEYS);
  return { op: stripped.value, ignored: stripped.ignored };
}

export function parseOp(raw: unknown): { ok: true; op: GearOpIn; ignored: string[] } | { ok: false; errors: Record<string, string> } {
  const stripped = stripOp(raw);
  if (!stripped) return { ok: false, errors: { op: 'Expected an object.' } };
  const parsed = opBodySchema.safeParse(stripped.op);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || 'op';
      if (!errors[key]) errors[key] = issue.message;
    }
    return { ok: false, errors };
  }
  return { ok: true, op: parsed.data, ignored: stripped.ignored };
}

export type SyncListIn = {
  list_id: string;
  since_version: number;
  ops: GearOpIn[];
  ignored: IgnoredOpKey[];
};

export type SyncEnvelope = {
  schemaVersion: number;
  source: SyncSource;
  characterId?: string;
  realm?: string;
  name?: string;
  lists: SyncListIn[];
};

/**
 * Parse POST /sync body.
 * Accepts either:
 *   { source, characterId|realm+name, lists: [{ list_id, since_version, ops[] }] }
 * or a single-list shorthand:
 *   { source, characterId|realm+name, since_version, ops[] }  (ops must carry list_id)
 */
export function parseSyncBody(
  raw: unknown,
): { ok: true; value: SyncEnvelope } | { ok: false; fieldErrors: Record<string, string> } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, fieldErrors: { body: 'Expected a JSON object.' } };
  }
  const obj = raw as Record<string, unknown>;
  const { value: env, ignored: envIgnored } = stripObject(obj, ENVELOPE_KEYS);
  if (envIgnored.length) {
    return { ok: false, fieldErrors: { body: `Unknown keys: ${envIgnored.join(', ')}` } };
  }

  const schemaVersion = env.schemaVersion === undefined ? GEAR_SCHEMA_VERSION : env.schemaVersion;
  if (schemaVersion !== GEAR_SCHEMA_VERSION) {
    return {
      ok: false,
      fieldErrors: { schemaVersion: `unsupported (server max ${GEAR_SCHEMA_VERSION})` },
    };
  }

  const syncSourceSchema = z.enum(SYNC_SOURCES);
  const sourceParsed = syncSourceSchema.safeParse(env.source ?? 'export');
  if (!sourceParsed.success) {
    return { ok: false, fieldErrors: { source: 'Must be addon|companion|export (web/system not accepted from clients).' } };
  }

  const characterId = env.characterId === undefined ? undefined : String(env.characterId);
  const realm = env.realm === undefined ? undefined : String(env.realm);
  const name = env.name === undefined ? undefined : String(env.name);
  if (!characterId && !(realm && name)) {
    return {
      ok: false,
      fieldErrors: { characterId: 'Provide characterId or realm+name.' },
    };
  }

  const lists: SyncListIn[] = [];

  if (Array.isArray(env.lists)) {
    if (env.lists.length > 50) {
      return { ok: false, fieldErrors: { lists: 'Too many lists (max 50).' } };
    }
    for (let i = 0; i < env.lists.length; i++) {
      const entry = env.lists[i];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return { ok: false, fieldErrors: { [`lists.${i}`]: 'Expected an object.' } };
      }
      const e = entry as Record<string, unknown>;
      const listId = z.string().uuid().safeParse(e.list_id);
      const since = z.number().int().min(0).safeParse(e.since_version ?? 0);
      if (!listId.success) return { ok: false, fieldErrors: { [`lists.${i}.list_id`]: 'Invalid uuid.' } };
      if (!since.success) return { ok: false, fieldErrors: { [`lists.${i}.since_version`]: 'Invalid.' } };
      const opsRaw = Array.isArray(e.ops) ? e.ops : [];
      if (opsRaw.length > MAX_OPS_PER_REQUEST) {
        return { ok: false, fieldErrors: { [`lists.${i}.ops`]: `Max ${MAX_OPS_PER_REQUEST} ops.` } };
      }
      const ops: GearOpIn[] = [];
      const ignored: IgnoredOpKey[] = [];
      for (let j = 0; j < opsRaw.length; j++) {
        const p = parseOp(opsRaw[j]);
        if (!p.ok) {
          return { ok: false, fieldErrors: { [`lists.${i}.ops.${j}`]: Object.values(p.errors)[0] ?? 'Invalid op.' } };
        }
        ops.push({ ...p.op, list_id: p.op.list_id ?? listId.data });
        if (p.ignored.length) ignored.push({ op_id: p.op.op_id, keys: p.ignored });
      }
      lists.push({ list_id: listId.data, since_version: since.data, ops, ignored });
    }
  } else if (Array.isArray(env.ops)) {
    const since = z.number().int().min(0).safeParse(env.since_version ?? 0);
    if (!since.success) return { ok: false, fieldErrors: { since_version: 'Invalid.' } };
    if (env.ops.length > MAX_OPS_PER_REQUEST) {
      return { ok: false, fieldErrors: { ops: `Max ${MAX_OPS_PER_REQUEST} ops.` } };
    }
    const byList = new Map<string, SyncListIn>();
    for (let j = 0; j < env.ops.length; j++) {
      const p = parseOp(env.ops[j]);
      if (!p.ok) {
        return { ok: false, fieldErrors: { [`ops.${j}`]: Object.values(p.errors)[0] ?? 'Invalid op.' } };
      }
      if (!p.op.list_id) {
        return { ok: false, fieldErrors: { [`ops.${j}.list_id`]: 'Required when not using lists[].' } };
      }
      let bucket = byList.get(p.op.list_id);
      if (!bucket) {
        bucket = { list_id: p.op.list_id, since_version: since.data, ops: [], ignored: [] };
        byList.set(p.op.list_id, bucket);
      }
      bucket.ops.push(p.op);
      if (p.ignored.length) bucket.ignored.push({ op_id: p.op.op_id, keys: p.ignored });
    }
    lists.push(...byList.values());
  }

  const totalOps = lists.reduce((n, l) => n + l.ops.length, 0);
  if (totalOps > MAX_SYNC_TOTAL_OPS) {
    return {
      ok: false,
      fieldErrors: { ops: `Too many ops across lists (max ${MAX_SYNC_TOTAL_OPS}).` },
    };
  }

  return {
    ok: true,
    value: {
      schemaVersion: GEAR_SCHEMA_VERSION,
      source: sourceParsed.data,
      characterId,
      realm,
      name,
      lists,
    },
  };
}

export function idempotencyKeyForOp(opId: string): string {
  return `op:${opId}`;
}

export function idempotencyKeyForCreate(listId: string): string {
  return `create:${listId}`;
}
