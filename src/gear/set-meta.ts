/**
 * Named armory set metadata validation (platform#40).
 * Level checks run only on create and on PATCH that changes type / until_level.
 */
import { GEAR_SET_TYPES, MAX_ROLE_SPEC, type GearSetType } from './schema.js';

export type SetMetaInput = {
  type: GearSetType;
  untilLevel: number | null;
};

export function parseRoleSpec(raw: unknown): { ok: true; value: string | null } | { ok: false; detail: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, detail: 'Must be a string or null.' };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > MAX_ROLE_SPEC) {
    return { ok: false, detail: `Max ${MAX_ROLE_SPEC} characters.` };
  }
  if (/[\u0000-\u001f]/.test(trimmed)) {
    return { ok: false, detail: 'No control characters.' };
  }
  return { ok: true, value: trimmed };
}

export function parseSetType(raw: unknown): { ok: true; value: GearSetType } | { ok: false; detail: string } {
  if (raw !== 'leveling' && raw !== 'max_level') {
    return { ok: false, detail: 'Must be leveling or max_level.' };
  }
  return { ok: true, value: raw };
}

/**
 * Returns field→detail map for validation_error, or null when valid.
 * characterLevel null is treated as 0 for until_level_not_above_current_level.
 */
export function validateSetLevelRules(
  type: GearSetType,
  untilLevel: unknown,
  characterLevel: number | null,
): Record<string, string> | null {
  const fields: Record<string, string> = {};
  const level = characterLevel == null ? 0 : characterLevel;

  if (type === 'max_level') {
    if (untilLevel !== undefined && untilLevel !== null) {
      fields.until_level = 'until_level_must_be_null';
    }
  } else {
    // leveling
    if (level >= 60) {
      fields.type = 'leveling_set_at_max_level';
    }
    if (untilLevel === undefined || untilLevel === null) {
      fields.until_level = 'until_level_required';
    } else if (typeof untilLevel !== 'number' || !Number.isInteger(untilLevel)) {
      fields.until_level = 'until_level_out_of_range';
    } else if (untilLevel < 1 || untilLevel > 60) {
      fields.until_level = 'until_level_out_of_range';
    } else if (untilLevel <= level) {
      fields.until_level = 'until_level_not_above_current_level';
    }
  }

  return Object.keys(fields).length ? fields : null;
}

export function computeOutgrown(
  type: GearSetType,
  untilLevel: number | null,
  characterLevel: number | null,
): boolean {
  return type === 'leveling' && characterLevel != null && untilLevel != null && characterLevel >= untilLevel;
}

export function isGearSetType(v: unknown): v is GearSetType {
  return typeof v === 'string' && (GEAR_SET_TYPES as readonly string[]).includes(v);
}
