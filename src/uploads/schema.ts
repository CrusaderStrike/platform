/**
 * Addon upload payload validation (platform#3).
 * Source of truth for field shapes: CrusaderStrike/addon docs/run-schema.md + docs/pvp-schema.md.
 * Envelope is strict; per-record / stats unknown keys are soft-ignored (stripped) with warnings.
 */
import { z } from 'zod';

export const SERVER_SCHEMA_VERSION = 1;
export const MAX_UPLOAD_BYTES = 1_048_576;
/** Match addon PvpHistory WORLD_CAP / BG_CAP. */
export const WORLD_PVP_CAP = 1000;
export const BATTLEGROUND_CAP = 500;
/** Per-request dungeon-run cap (SavedVariables can grow; keep request bounded). */
export const DUNGEON_RUN_CAP = 100;

/** Unix seconds upper bound (~year 2100); avoids absurd timestamps / overflow. */
export const UNIX_SEC_MAX = 4_102_444_800;
/** Cap duration so durationSec*1000 fits Postgres INTEGER. */
export const DURATION_SEC_MAX = 2_000_000;

const nonEmptyStr = (max: number) => z.string().min(1).max(max);
const unixSec = z.number().int().nonnegative().max(UNIX_SEC_MAX);
const durationSec = z.number().int().nonnegative().max(DURATION_SEC_MAX);

/** Clamp invalid party/opponent levels (e.g. addon -1) to null. */
function clampLevel(n: unknown): number | null | undefined {
  if (n === undefined) return undefined;
  if (n === null) return null;
  if (typeof n !== 'number' || !Number.isInteger(n)) return n as never;
  if (n < 1 || n > 60) return null;
  return n;
}

export type IgnoredKey = {
  kind: 'dungeon_run' | 'world_pvp' | 'battleground' | 'envelope';
  id: string;
  keys: string[];
};

const PARTY_MEMBER_KEYS = new Set(['name', 'realm', 'class', 'level', 'isPlayer']);
const BOSS_KEYS = new Set(['npcId', 'name', 'killedAt']);
const DEATH_KEYS = new Set(['name', 'realm', 'time', 'source']);
const DUNGEON_RUN_KEYS = new Set([
  'schemaVersion',
  'gameVersion',
  'idempotencyKey',
  'addonRunId',
  'realm',
  'character',
  'instance',
  'startedAt',
  'endedAt',
  'durationSec',
  'completed',
  'status',
  'party',
  'bosses',
  'deaths',
]);
const INSTANCE_KEYS = new Set(['id', 'name', 'difficulty', 'difficultyName']);
const OPPONENT_KEYS = new Set(['name', 'realm', 'class', 'level', 'faction']);
const WORLD_PVP_KEYS = new Set([
  'v',
  'addon_pvp_id',
  'time',
  'zone',
  'subzone',
  'result',
  'honorable',
  'killer_source',
  'opponent',
]);
const BG_KEYS = new Set([
  'v',
  'addon_pvp_id',
  'mapId',
  'mapName',
  'faction',
  'startedAt',
  'endedAt',
  'durationSec',
  'result',
  'winner',
  'stats',
]);
const BG_STATS_KEYS = new Set(['honorableKills', 'deaths', 'honor']);

function stripObject(
  raw: Record<string, unknown>,
  allowed: Set<string>,
  pathPrefix: string,
): { value: Record<string, unknown>; ignored: string[] } {
  const value: Record<string, unknown> = {};
  const ignored: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (allowed.has(k)) value[k] = v;
    else ignored.push(pathPrefix ? `${pathPrefix}.${k}` : k);
  }
  return { value, ignored };
}

function stripArrayObjects(
  arr: unknown,
  allowed: Set<string>,
  pathPrefix: string,
): { value: unknown; ignored: string[] } {
  if (!Array.isArray(arr)) return { value: arr, ignored: [] };
  const ignored: string[] = [];
  const value = arr.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const s = stripObject(item as Record<string, unknown>, allowed, `${pathPrefix}[${i}]`);
    ignored.push(...s.ignored);
    return s.value;
  });
  return { value, ignored };
}

/** Strip unknown keys from a dungeon-run record (soft-ignore). */
export function stripDungeonRun(raw: unknown): { value: unknown; ignored: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: raw, ignored: [] };
  const ignored: string[] = [];
  const top = stripObject(raw as Record<string, unknown>, DUNGEON_RUN_KEYS, '');
  ignored.push(...top.ignored);
  const value = { ...top.value };
  if (value.instance && typeof value.instance === 'object' && !Array.isArray(value.instance)) {
    const inst = stripObject(value.instance as Record<string, unknown>, INSTANCE_KEYS, 'instance');
    ignored.push(...inst.ignored);
    value.instance = inst.value;
  }
  if (value.party !== undefined) {
    const p = stripArrayObjects(value.party, PARTY_MEMBER_KEYS, 'party');
    ignored.push(...p.ignored);
    value.party = p.value;
  }
  if (value.bosses !== undefined) {
    const b = stripArrayObjects(value.bosses, BOSS_KEYS, 'bosses');
    ignored.push(...b.ignored);
    value.bosses = b.value;
  }
  if (value.deaths !== undefined) {
    const d = stripArrayObjects(value.deaths, DEATH_KEYS, 'deaths');
    ignored.push(...d.ignored);
    value.deaths = d.value;
  }
  return { value, ignored };
}

export function stripWorldPvp(raw: unknown): { value: unknown; ignored: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: raw, ignored: [] };
  const ignored: string[] = [];
  const top = stripObject(raw as Record<string, unknown>, WORLD_PVP_KEYS, '');
  ignored.push(...top.ignored);
  const value = { ...top.value };
  if (value.opponent && typeof value.opponent === 'object' && !Array.isArray(value.opponent)) {
    const o = stripObject(value.opponent as Record<string, unknown>, OPPONENT_KEYS, 'opponent');
    ignored.push(...o.ignored);
    value.opponent = o.value;
  }
  return { value, ignored };
}

export function stripBattleground(raw: unknown): { value: unknown; ignored: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: raw, ignored: [] };
  const ignored: string[] = [];
  const top = stripObject(raw as Record<string, unknown>, BG_KEYS, '');
  ignored.push(...top.ignored);
  const value = { ...top.value };
  if (value.stats && typeof value.stats === 'object' && !Array.isArray(value.stats)) {
    const s = stripObject(value.stats as Record<string, unknown>, BG_STATS_KEYS, 'stats');
    ignored.push(...s.ignored);
    value.stats = s.value;
  }
  return { value, ignored };
}

export const partyMemberSchema = z
  .object({
    name: nonEmptyStr(48),
    realm: nonEmptyStr(48),
    class: nonEmptyStr(32),
    level: z.preprocess(clampLevel, z.number().int().min(1).max(60).nullable().optional()),
    isPlayer: z.boolean().optional(),
  })
  .strict();

export const bossKillSchema = z
  .object({
    npcId: z.number().int().positive(),
    name: nonEmptyStr(64),
    killedAt: unixSec.nullable().optional(),
  })
  .strict();

export const deathSchema = z
  .object({
    name: nonEmptyStr(48),
    realm: nonEmptyStr(48),
    time: unixSec,
    source: z.string().max(64).nullable().optional(),
  })
  .strict();

export const dungeonRunSchema = z
  .object({
    schemaVersion: z.literal(1),
    gameVersion: z.literal('forever'),
    idempotencyKey: nonEmptyStr(160),
    addonRunId: nonEmptyStr(160),
    realm: nonEmptyStr(48),
    character: nonEmptyStr(48),
    instance: z
      .object({
        id: z.number().int().positive(),
        name: nonEmptyStr(64),
        difficulty: z.number().int().nullable().optional(),
        difficultyName: z.string().max(64).nullable().optional(),
      })
      .strict(),
    startedAt: unixSec,
    endedAt: unixSec.nullable().optional(),
    durationSec: durationSec.nullable().optional(),
    completed: z.boolean(),
    status: z.enum(['in_progress', 'closed', 'completed']),
    party: z.array(partyMemberSchema).min(1).max(40),
    bosses: z.array(bossKillSchema).max(50),
    deaths: z.array(deathSchema).max(500),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.idempotencyKey !== v.addonRunId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Must equal addonRunId',
        path: ['idempotencyKey'],
      });
    }
  });

export const opponentSchema = z
  .object({
    name: z.string().max(48).nullable().optional(),
    realm: z.string().max(48).nullable().optional(),
    class: z.string().max(32).nullable().optional(),
    level: z.preprocess(clampLevel, z.number().int().min(1).max(60).nullable().optional()),
    faction: z.enum(['alliance', 'horde']).nullable().optional(),
  })
  .strict();

export const worldPvpSchema = z
  .object({
    v: z.literal(1),
    addon_pvp_id: nonEmptyStr(200),
    time: unixSec,
    zone: z.string().max(64).nullable().optional(),
    subzone: z.string().max(64).nullable().optional(),
    result: z.enum(['kill', 'death']),
    honorable: z.boolean(),
    killer_source: z.enum(['target', 'combat_log']).nullable().optional(),
    opponent: opponentSchema.nullable().optional(),
  })
  .strict();

export const battlegroundSchema = z
  .object({
    v: z.literal(1),
    addon_pvp_id: nonEmptyStr(200),
    mapId: z.number().int().positive(),
    mapName: nonEmptyStr(64),
    faction: z.enum(['alliance', 'horde']).nullable().optional(),
    startedAt: unixSec,
    endedAt: unixSec,
    durationSec: durationSec,
    result: z.enum(['win', 'loss', 'left', 'draw']),
    winner: z.union([z.literal(0), z.literal(1), z.literal(255)]).nullable().optional(),
    // killingBlows and other unknown stats keys are stripped before parse.
    stats: z
      .object({
        honorableKills: z.number().int().nonnegative().optional(),
        deaths: z.number().int().nonnegative().optional(),
        honor: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const uploadBodySchema = z
  .object({
    schemaVersion: z.literal(SERVER_SCHEMA_VERSION),
    characterId: nonEmptyStr(128).optional(),
    /** Alternative to characterId: resolve by realm + character name. */
    realm: nonEmptyStr(48).optional(),
    name: nonEmptyStr(48).optional(),
    dungeonRuns: z.array(z.unknown()).max(DUNGEON_RUN_CAP).optional().default([]),
    worldPvp: z.array(z.unknown()).max(WORLD_PVP_CAP).optional().default([]),
    battlegrounds: z.array(z.unknown()).max(BATTLEGROUND_CAP).optional().default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.characterId && !(v.realm && v.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide characterId, or realm and name.',
        path: ['characterId'],
      });
    }
    const n =
      (v.dungeonRuns?.length ?? 0) + (v.worldPvp?.length ?? 0) + (v.battlegrounds?.length ?? 0);
    if (n < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide at least one dungeonRuns, worldPvp, or battlegrounds record.',
        path: ['dungeonRuns'],
      });
    }
  });

export type UploadBodyEnvelope = z.infer<typeof uploadBodySchema>;
export type DungeonRunIn = z.infer<typeof dungeonRunSchema>;
export type WorldPvpIn = z.infer<typeof worldPvpSchema>;
export type BattlegroundIn = z.infer<typeof battlegroundSchema>;

export type ParsedUpload = {
  schemaVersion: number;
  characterId?: string;
  realm?: string;
  name?: string;
  dungeonRuns: Array<{ record: DungeonRunIn; ignored: string[] }>;
  worldPvp: Array<{ record: WorldPvpIn; ignored: string[] }>;
  battlegrounds: Array<{ record: BattlegroundIn; ignored: string[] }>;
  fieldErrors: Record<string, string>;
};

/** Soft-strip record unknowns, then strict-parse known shape. Envelope stays strict. */
export function parseUploadBody(raw: unknown): ParsedUpload | { fieldErrors: Record<string, string> } {
  const env = uploadBodySchema.safeParse(raw);
  if (!env.success) {
    return { fieldErrors: zodErrorsToFields(env.error) };
  }
  const fieldErrors: Record<string, string> = {};
  const dungeonRuns: ParsedUpload['dungeonRuns'] = [];
  const worldPvp: ParsedUpload['worldPvp'] = [];
  const battlegrounds: ParsedUpload['battlegrounds'] = [];

  (env.data.dungeonRuns ?? []).forEach((item, i) => {
    const stripped = stripDungeonRun(item);
    const parsed = dungeonRunSchema.safeParse(stripped.value);
    if (!parsed.success) {
      Object.assign(
        fieldErrors,
        Object.fromEntries(
          Object.entries(zodErrorsToFields(parsed.error)).map(([k, v]) => [`dungeonRuns.${i}${k ? '.' + k : ''}`, v]),
        ),
      );
      return;
    }
    dungeonRuns.push({ record: parsed.data, ignored: stripped.ignored });
  });

  (env.data.worldPvp ?? []).forEach((item, i) => {
    const stripped = stripWorldPvp(item);
    const parsed = worldPvpSchema.safeParse(stripped.value);
    if (!parsed.success) {
      Object.assign(
        fieldErrors,
        Object.fromEntries(
          Object.entries(zodErrorsToFields(parsed.error)).map(([k, v]) => [`worldPvp.${i}${k ? '.' + k : ''}`, v]),
        ),
      );
      return;
    }
    worldPvp.push({ record: parsed.data, ignored: stripped.ignored });
  });

  (env.data.battlegrounds ?? []).forEach((item, i) => {
    const stripped = stripBattleground(item);
    const parsed = battlegroundSchema.safeParse(stripped.value);
    if (!parsed.success) {
      Object.assign(
        fieldErrors,
        Object.fromEntries(
          Object.entries(zodErrorsToFields(parsed.error)).map(([k, v]) => [
            `battlegrounds.${i}${k ? '.' + k : ''}`,
            v,
          ]),
        ),
      );
      return;
    }
    battlegrounds.push({ record: parsed.data, ignored: stripped.ignored });
  });

  if (Object.keys(fieldErrors).length) return { fieldErrors };

  return {
    schemaVersion: env.data.schemaVersion,
    characterId: env.data.characterId,
    realm: env.data.realm,
    name: env.data.name,
    dungeonRuns,
    worldPvp,
    battlegrounds,
    fieldErrors: {},
  };
}

export function zodErrorsToFields(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const path = issue.path.length ? issue.path.join('.') : 'body';
    if (!out[path]) out[path] = issue.message;
  }
  return out;
}

export function normName(s: string): string {
  return s.trim().toLowerCase();
}

/** addon_pvp_id is Realm|Character|W|... or Realm|Character|BG|... */
export function pvpIdPrefix(addonPvpId: string): { realm: string; character: string } | null {
  const parts = addonPvpId.split('|');
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return { realm: parts[0], character: parts[1] };
}

export function matchesCharacter(
  owned: { character_name: string; realm: string | null },
  realm: string,
  character: string,
): boolean {
  if (!owned.realm) return false;
  return normName(owned.realm) === normName(realm) && normName(owned.character_name) === normName(character);
}

export const STATUS_RANK: Record<'in_progress' | 'closed' | 'completed', number> = {
  in_progress: 0,
  closed: 1,
  completed: 2,
};
