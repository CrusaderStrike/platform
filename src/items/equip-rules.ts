/**
 * Pure Classic / Forever equip rules used by the items API class filter.
 * No I/O — unit-tested in isolation.
 */
import type { PlayableClass } from './playable-classes.js';
import type { ArmorType } from './mapping.js';

/** Blizzard item_class ids. */
export const ITEM_CLASS_WEAPON = 2;
export const ITEM_CLASS_ARMOR = 4;
export const ITEM_CLASS_AMMO = 6;

/** Weapon subclasses (item_class = 2). */
export const WEAPON_SUB = {
  AXE_1H: 0,
  AXE_2H: 1,
  BOW: 2,
  GUN: 3,
  MACE_1H: 4,
  MACE_2H: 5,
  POLEARM: 6,
  SWORD_1H: 7,
  SWORD_2H: 8,
  STAFF: 10,
  FIST: 13,
  MISC: 14,
  DAGGER: 15,
  THROWN: 16,
  CROSSBOW: 18,
  WAND: 19,
  FISHING_POLE: 20,
} as const;

/** Armor subclasses (item_class = 4). */
export const ARMOR_SUB = {
  MISC: 0,
  CLOTH: 1,
  LEATHER: 2,
  MAIL: 3,
  PLATE: 4,
  SHIELD: 6,
  LIBRAM: 7,
  IDOL: 8,
  TOTEM: 9,
} as const;

/** Ammo subclasses (item_class = 6). */
export const AMMO_SUB = {
  ARROW: 2,
  BULLET: 3,
} as const;

const ARMOR_TIER: Record<PlayableClass, ReadonlySet<ArmorType>> = {
  warrior: new Set(['cloth', 'leather', 'mail', 'plate']),
  paladin: new Set(['cloth', 'leather', 'mail', 'plate']),
  hunter: new Set(['cloth', 'leather', 'mail']),
  shaman: new Set(['cloth', 'leather', 'mail']),
  druid: new Set(['cloth', 'leather']),
  rogue: new Set(['cloth', 'leather']),
  mage: new Set(['cloth']),
  priest: new Set(['cloth']),
  warlock: new Set(['cloth']),
};

/** Weapon subclasses each class can equip (Classic Forever). */
const WEAPON_SUBCLASSES: Record<PlayableClass, ReadonlySet<number>> = {
  warrior: new Set([
    WEAPON_SUB.AXE_1H,
    WEAPON_SUB.AXE_2H,
    WEAPON_SUB.BOW,
    WEAPON_SUB.GUN,
    WEAPON_SUB.MACE_1H,
    WEAPON_SUB.MACE_2H,
    WEAPON_SUB.POLEARM,
    WEAPON_SUB.SWORD_1H,
    WEAPON_SUB.SWORD_2H,
    WEAPON_SUB.STAFF,
    WEAPON_SUB.FIST,
    WEAPON_SUB.DAGGER,
    WEAPON_SUB.THROWN,
    WEAPON_SUB.CROSSBOW,
  ]),
  paladin: new Set([
    WEAPON_SUB.AXE_1H,
    WEAPON_SUB.AXE_2H,
    WEAPON_SUB.MACE_1H,
    WEAPON_SUB.MACE_2H,
    WEAPON_SUB.POLEARM,
    WEAPON_SUB.SWORD_1H,
    WEAPON_SUB.SWORD_2H,
  ]),
  hunter: new Set([
    WEAPON_SUB.AXE_1H,
    WEAPON_SUB.AXE_2H,
    WEAPON_SUB.BOW,
    WEAPON_SUB.GUN,
    WEAPON_SUB.SWORD_1H,
    WEAPON_SUB.SWORD_2H,
    WEAPON_SUB.POLEARM,
    WEAPON_SUB.STAFF,
    WEAPON_SUB.DAGGER,
    WEAPON_SUB.FIST,
    WEAPON_SUB.THROWN,
    WEAPON_SUB.CROSSBOW,
  ]),
  rogue: new Set([
    WEAPON_SUB.BOW,
    WEAPON_SUB.GUN,
    WEAPON_SUB.MACE_1H,
    WEAPON_SUB.SWORD_1H,
    WEAPON_SUB.FIST,
    WEAPON_SUB.DAGGER,
    WEAPON_SUB.THROWN,
    WEAPON_SUB.CROSSBOW,
  ]),
  priest: new Set([WEAPON_SUB.MACE_1H, WEAPON_SUB.STAFF, WEAPON_SUB.DAGGER, WEAPON_SUB.WAND]),
  shaman: new Set([
    WEAPON_SUB.AXE_1H,
    WEAPON_SUB.AXE_2H,
    WEAPON_SUB.MACE_1H,
    WEAPON_SUB.MACE_2H,
    WEAPON_SUB.STAFF,
    WEAPON_SUB.FIST,
    WEAPON_SUB.DAGGER,
  ]),
  mage: new Set([WEAPON_SUB.SWORD_1H, WEAPON_SUB.STAFF, WEAPON_SUB.DAGGER, WEAPON_SUB.WAND]),
  warlock: new Set([WEAPON_SUB.SWORD_1H, WEAPON_SUB.STAFF, WEAPON_SUB.DAGGER, WEAPON_SUB.WAND]),
  druid: new Set([
    WEAPON_SUB.MACE_1H,
    WEAPON_SUB.MACE_2H,
    WEAPON_SUB.POLEARM,
    WEAPON_SUB.STAFF,
    WEAPON_SUB.FIST,
    WEAPON_SUB.DAGGER,
  ]),
};

const DUAL_WIELD: ReadonlySet<PlayableClass> = new Set(['warrior', 'hunter', 'rogue']);
const SHIELD_CLASSES: ReadonlySet<PlayableClass> = new Set(['warrior', 'paladin', 'shaman']);
const AMMO_CLASSES: ReadonlySet<PlayableClass> = new Set(['warrior', 'hunter', 'rogue']);

const RELIC_SUB_BY_CLASS: Partial<Record<PlayableClass, number>> = {
  paladin: ARMOR_SUB.LIBRAM,
  druid: ARMOR_SUB.IDOL,
  shaman: ARMOR_SUB.TOTEM,
};

const JUNK_NAME_RES: readonly RegExp[] = [
  /^Monster\b/i,
  /\b\(TEST\)\b/i,
  /\bTest\b/i,
  /\[PH\]/i,
  /\bDeprecated\b/i,
  /\bAHNQIRAJ\s+TEST\b/i,
];

export type EquipItemView = {
  name: string;
  inventoryType: string;
  itemClass: number | null;
  itemSubclass: number | null;
  armorType: string | null;
  /** Effective class restriction (item's own, else set's). Null/empty = unrestricted. */
  allowedClasses: string[] | null;
};

export function isJunkItemName(name: string): boolean {
  return JUNK_NAME_RES.some((re) => re.test(name));
}

export function armorTypesForClass(cls: PlayableClass): ReadonlySet<ArmorType> {
  return ARMOR_TIER[cls];
}

export function weaponSubclassesForClass(cls: PlayableClass): ReadonlySet<number> {
  return WEAPON_SUBCLASSES[cls];
}

export function canDualWield(cls: PlayableClass): boolean {
  return DUAL_WIELD.has(cls);
}

export function canUseShield(cls: PlayableClass): boolean {
  return SHIELD_CLASSES.has(cls);
}

export function canUseAmmo(cls: PlayableClass): boolean {
  return AMMO_CLASSES.has(cls);
}

export function relicSubclassForClass(cls: PlayableClass): number | null {
  return RELIC_SUB_BY_CLASS[cls] ?? null;
}

function inv(raw: string | null | undefined): string {
  return (raw ?? '').toUpperCase().replace(/\s+/g, '');
}

/**
 * Whether `cls` can equip this item under Classic Forever rules + class-set ownership.
 * Junk names are rejected. Unrestricted items still must match armor/weapon/relic/ammo rules.
 */
export function classCanEquip(cls: PlayableClass, item: EquipItemView): boolean {
  if (isJunkItemName(item.name)) return false;

  const allowed = item.allowedClasses?.filter(Boolean) ?? [];
  if (allowed.length > 0 && !allowed.map((c) => c.toLowerCase()).includes(cls)) {
    return false;
  }

  const itype = inv(item.inventoryType);
  const ic = item.itemClass;
  const isc = item.itemSubclass;

  // Ammo
  if (itype === 'AMMO' || ic === ITEM_CLASS_AMMO) {
    if (!canUseAmmo(cls)) return false;
    if (isc == null) return true;
    return isc === AMMO_SUB.ARROW || isc === AMMO_SUB.BULLET;
  }

  // Relics / librams / idols / totems (armor class, RELIC inventory, or subclass 7/8/9)
  if (
    itype === 'RELIC' ||
    (ic === ITEM_CLASS_ARMOR &&
      isc != null &&
      (isc === ARMOR_SUB.LIBRAM || isc === ARMOR_SUB.IDOL || isc === ARMOR_SUB.TOTEM))
  ) {
    const want = relicSubclassForClass(cls);
    if (want == null) return false;
    if (isc == null) return false;
    return isc === want;
  }

  // Shields
  if (itype === 'SHIELD' || (ic === ITEM_CLASS_ARMOR && isc === ARMOR_SUB.SHIELD)) {
    return canUseShield(cls);
  }

  // Held-in-off-hand (non-weapon, non-shield)
  if (itype === 'HOLDABLE') {
    return true;
  }

  // Armor with an armor_type (cloth/leather/mail/plate)
  if (item.armorType) {
    return armorTypesForClass(cls).has(item.armorType as ArmorType);
  }

  // Weapons
  if (ic === ITEM_CLASS_WEAPON) {
    if (isc == null) return false;
    if (isc === WEAPON_SUB.FISHING_POLE) return true; // all classes can hold a pole
    if (!weaponSubclassesForClass(cls).has(isc)) return false;

    // Main-hand-only never in off-hand context is enforced by slot filter + aliases;
    // here we only gate whether the class can equip the weapon type at all.
    // One-hand weapons in off_hand require dual wield — applied when slot is off_hand.
    return true;
  }

  // Armor misc (rings, necks, cloaks, shirts, tabards) — no armor_type
  if (ic === ITEM_CLASS_ARMOR) {
    // Cloth/leather/mail/plate without armorType should not happen; treat subclass directly
    if (isc === ARMOR_SUB.CLOTH || isc === ARMOR_SUB.LEATHER || isc === ARMOR_SUB.MAIL || isc === ARMOR_SUB.PLATE) {
      const map: Record<number, ArmorType> = {
        [ARMOR_SUB.CLOTH]: 'cloth',
        [ARMOR_SUB.LEATHER]: 'leather',
        [ARMOR_SUB.MAIL]: 'mail',
        [ARMOR_SUB.PLATE]: 'plate',
      };
      return armorTypesForClass(cls).has(map[isc]!);
    }
    // Rings, necks, cloaks, shirts, tabards, etc.
    return true;
  }

  // Unknown item class with no armor type — allow (trinkets etc. may be class 4 already)
  return true;
}

/**
 * Extra gate when the caller is browsing the off_hand slot: one-hand weapons
 * require dual wield; main-hand-only weapons never appear; shields/held OK per rules.
 */
export function classCanEquipInOffHand(cls: PlayableClass, item: EquipItemView): boolean {
  if (!classCanEquip(cls, item)) return false;
  const itype = inv(item.inventoryType);
  if (itype === 'WEAPONMAINHAND' || itype === 'TWOHWEAPON' || itype === '2HWEAPON') {
    return false;
  }
  if (itype === 'WEAPON') {
    return canDualWield(cls);
  }
  if (itype === 'SHIELD') return canUseShield(cls);
  if (itype === 'HOLDABLE' || itype === 'WEAPONOFFHAND') return true;
  return true;
}

/**
 * Build SQL fragments for the items list filter.
 * Returns parameterized predicates (caller supplies starting $N index).
 */
export type SqlFrag = { sql: string; params: unknown[] };

export function junkExclusionSql(nameColumn = 'name'): string {
  // Match the same junk patterns used by isJunkItemName.
  return `(
    ${nameColumn} !~* '^Monster[[:space:]]'
    AND ${nameColumn} !~* '\\(TEST\\)'
    AND ${nameColumn} !~* '[[:space:]]Test[[:space:]]|^Test[[:space:]]|[[:space:]]Test$'
    AND ${nameColumn} !~* '\\[PH\\]'
    AND ${nameColumn} !~* 'Deprecated'
    AND ${nameColumn} !~* 'AHNQIRAJ[[:space:]]+TEST'
  )`;
}

/**
 * SQL predicate: item is equippable by `cls` (armor/weapon/relic/ammo + dual-wield off_hand).
 * Assumes columns: name, inventory_type, item_class, item_subclass, armor_type,
 * and `effective_allowed_classes` (text[] | null) already in scope (via JOIN/subquery).
 */
export function classEquipSql(
  cls: PlayableClass,
  slot: string | undefined,
  startParam: number,
): SqlFrag {
  const params: unknown[] = [];
  const parts: string[] = [];

  // Class-set ownership
  params.push(cls);
  const classParam = `$${startParam + params.length - 1}`;
  parts.push(
    `(effective_allowed_classes IS NULL OR cardinality(effective_allowed_classes) = 0 OR ${classParam} = ANY(effective_allowed_classes))`,
  );

  // Armor tier: when armor_type is set, it must be in the class's allowed set
  const armor = [...armorTypesForClass(cls)];
  params.push(armor);
  const armorParam = `$${startParam + params.length - 1}`;
  parts.push(`(armor_type IS NULL OR armor_type = ANY(${armorParam}::text[]))`);

  // Shields
  if (!canUseShield(cls)) {
    parts.push(`(upper(replace(inventory_type, ' ', '')) <> 'SHIELD' AND NOT (item_class = 4 AND item_subclass = 6))`);
  }

  // Ammo
  if (!canUseAmmo(cls)) {
    parts.push(`(upper(replace(inventory_type, ' ', '')) <> 'AMMO' AND item_class IS DISTINCT FROM 6)`);
  } else {
    parts.push(
      `(upper(replace(inventory_type, ' ', '')) <> 'AMMO' AND item_class IS DISTINCT FROM 6 OR item_subclass IS NULL OR item_subclass IN (2, 3))`,
    );
  }

  // Relics
  const relic = relicSubclassForClass(cls);
  if (relic == null) {
    parts.push(
      `(upper(replace(inventory_type, ' ', '')) <> 'RELIC' AND NOT (item_class = 4 AND item_subclass IN (7, 8, 9)))`,
    );
  } else {
    params.push(relic);
    const relicParam = `$${startParam + params.length - 1}`;
    parts.push(
      `(
        (upper(replace(inventory_type, ' ', '')) <> 'RELIC' AND NOT (item_class = 4 AND item_subclass IN (7, 8, 9)))
        OR item_subclass = ${relicParam}
      )`,
    );
  }

  // Weapons: subclass must be allowed (non-weapons pass)
  const weapons = [...weaponSubclassesForClass(cls), WEAPON_SUB.FISHING_POLE];
  params.push(weapons);
  const weaponsParam = `$${startParam + params.length - 1}`;
  parts.push(`(item_class IS DISTINCT FROM 2 OR item_subclass = ANY(${weaponsParam}::int[]))`);

  // Off-hand dual-wield / main-hand-only
  if (slot === 'off_hand') {
    parts.push(`(upper(replace(inventory_type, ' ', '')) NOT IN ('WEAPONMAINHAND', 'TWOHWEAPON', '2HWEAPON'))`);
    if (!canDualWield(cls)) {
      parts.push(`(upper(replace(inventory_type, ' ', '')) <> 'WEAPON')`);
    }
  }

  return { sql: parts.map((p) => `(${p})`).join(' AND '), params };
}
