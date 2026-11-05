/**
 * Addon upload payload validation (platform#3).
 * Source of truth for field shapes: CrusaderStrike/addon docs/run-schema.md + docs/pvp-schema.md.
 * Strict: additionalProperties / unknown keys rejected (zod .strict()).
 */
import { z } from 'zod';

export const SERVER_SCHEMA_VERSION = 1;
export const MAX_UPLOAD_BYTES = 1_048_576;
/** Match addon PvpHistory WORLD_CAP / BG_CAP. */
export const WORLD_PVP_CAP = 1000;
export const BATTLEGROUND_CAP = 500;
/** Per-request dungeon-run cap (SavedVariables can grow; keep request bounded). */
export const DUNGEON_RUN_CAP = 100;

const nonEmptyStr = (max: number) => z.string().min(1).max(max);
const unixSec = z.number().int().nonnegative();

export const partyMemberSchema = z
  .object({
    name: nonEmptyStr(48),
    realm: nonEmptyStr(48),
    class: nonEmptyStr(32),
    level: z.number().int().min(1).max(60).nullable().optional(),
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
    durationSec: z.number().int().nonnegative().nullable().optional(),
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
    level: z.number().int().min(1).max(60).nullable().optional(),
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
    durationSec: z.number().int().nonnegative(),
    result: z.enum(['win', 'loss', 'left', 'draw']),
    winner: z.union([z.literal(0), z.literal(1), z.literal(255)]).nullable().optional(),
    // Addon scoreboard may expose killingBlows; platform stores honorable_kills only.
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
    characterId: nonEmptyStr(128),
    dungeonRuns: z.array(dungeonRunSchema).max(DUNGEON_RUN_CAP).optional().default([]),
    worldPvp: z.array(worldPvpSchema).max(WORLD_PVP_CAP).optional().default([]),
    battlegrounds: z.array(battlegroundSchema).max(BATTLEGROUND_CAP).optional().default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
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

export type UploadBody = z.infer<typeof uploadBodySchema>;
export type DungeonRunIn = z.infer<typeof dungeonRunSchema>;
export type WorldPvpIn = z.infer<typeof worldPvpSchema>;
export type BattlegroundIn = z.infer<typeof battlegroundSchema>;

export function zodErrorsToFields(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const path = issue.path.length ? issue.path.join('.') : 'body';
    if (!out[path]) out[path] = issue.message;
  }
  return out;
}
