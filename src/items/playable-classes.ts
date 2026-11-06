/** Forever playable class keys (lowercase) and Blizzard playable-class ids. */

export const PLAYABLE_CLASSES = [
  'warrior',
  'paladin',
  'hunter',
  'rogue',
  'priest',
  'shaman',
  'mage',
  'warlock',
  'druid',
] as const;

export type PlayableClass = (typeof PLAYABLE_CLASSES)[number];

/** Blizzard Forever / Classic playable-class ids → keys. */
export const PLAYABLE_CLASS_BY_ID: Record<number, PlayableClass> = {
  1: 'warrior',
  2: 'paladin',
  3: 'hunter',
  4: 'rogue',
  5: 'priest',
  7: 'shaman',
  8: 'mage',
  9: 'warlock',
  11: 'druid',
};

export function isPlayableClass(value: string): value is PlayableClass {
  return (PLAYABLE_CLASSES as readonly string[]).includes(value);
}

/**
 * Map a Blizzard playable-class id or name to a lowercase key.
 * Accepts "Druid", "druid", "Classes: Druid", or numeric ids.
 */
export function normalizePlayableClass(raw: string | number | null | undefined): PlayableClass | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return PLAYABLE_CLASS_BY_ID[raw] ?? null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    return PLAYABLE_CLASS_BY_ID[Number(trimmed)] ?? null;
  }
  let name = trimmed.toLowerCase();
  if (name.startsWith('classes:')) {
    name = name.slice('classes:'.length).trim();
  }
  // Multi-class display strings are handled by the caller (split on commas).
  if (name.includes(',')) return null;
  return isPlayableClass(name) ? name : null;
}

export function normalizePlayableClassList(
  values: Array<string | number | null | undefined>,
): PlayableClass[] {
  const out = new Set<PlayableClass>();
  for (const v of values) {
    if (typeof v === 'string' && v.includes(',')) {
      for (const part of v.split(',')) {
        const c = normalizePlayableClass(part);
        if (c) out.add(c);
      }
      continue;
    }
    const c = normalizePlayableClass(v);
    if (c) out.add(c);
  }
  return [...out].sort();
}
