/**
 * Map Blizzard Forever inventory_type.type → platform GearSlot (+ aliases).
 * Finger / trinket / one-hand weapons may match multiple slots in search.
 */
import { GEAR_SLOTS, type GearSlot } from '../gear/schema.js';

export type SlotMapping = {
  slot: GearSlot;
  aliases: GearSlot[];
};

const INV_TO_SLOT: Record<string, SlotMapping> = {
  HEAD: { slot: 'head', aliases: [] },
  NECK: { slot: 'neck', aliases: [] },
  SHOULDER: { slot: 'shoulder', aliases: [] },
  BODY: { slot: 'shirt', aliases: [] },
  CHEST: { slot: 'chest', aliases: [] },
  WAIST: { slot: 'waist', aliases: [] },
  LEGS: { slot: 'legs', aliases: [] },
  FEET: { slot: 'feet', aliases: [] },
  WRIST: { slot: 'wrist', aliases: [] },
  HAND: { slot: 'hands', aliases: [] },
  FINGER: { slot: 'finger1', aliases: ['finger2'] },
  TRINKET: { slot: 'trinket1', aliases: ['trinket2'] },
  WEAPON: { slot: 'main_hand', aliases: ['off_hand'] },
  '2HWEAPON': { slot: 'main_hand', aliases: [] },
  WEAPONMAINHAND: { slot: 'main_hand', aliases: [] },
  WEAPONOFFHAND: { slot: 'off_hand', aliases: [] },
  HOLDABLE: { slot: 'off_hand', aliases: [] },
  SHIELD: { slot: 'off_hand', aliases: [] },
  RANGED: { slot: 'ranged', aliases: [] },
  RANGEDRIGHT: { slot: 'ranged', aliases: [] },
  THROWN: { slot: 'ranged', aliases: [] },
  CLOAK: { slot: 'back', aliases: [] },
  TABARD: { slot: 'tabard', aliases: [] },
  ROBE: { slot: 'chest', aliases: [] },
  AMMO: { slot: 'ranged', aliases: [] },
  RELIC: { slot: 'ranged', aliases: [] },
};

/** Armor item_subclass → armor_type (Blizzard Item Class 4). */
const ARMOR_SUBCLASS: Record<number, string> = {
  1: 'cloth',
  2: 'leather',
  3: 'mail',
  4: 'plate',
};

export const ARMOR_TYPES = ['cloth', 'leather', 'mail', 'plate'] as const;
export type ArmorType = (typeof ARMOR_TYPES)[number];

export function isGearSlot(value: string): value is GearSlot {
  return (GEAR_SLOTS as readonly string[]).includes(value);
}

export function isArmorType(value: string): value is ArmorType {
  return (ARMOR_TYPES as readonly string[]).includes(value);
}

export function mapInventoryType(inventoryType: string | null | undefined): SlotMapping | null {
  if (!inventoryType) return null;
  const key = inventoryType.toUpperCase().replace(/\s+/g, '');
  return INV_TO_SLOT[key] ?? null;
}

export function armorTypeFromClass(
  itemClass: number | null | undefined,
  itemSubclass: number | null | undefined,
): string | null {
  if (itemClass !== 4 || itemSubclass == null) return null;
  return ARMOR_SUBCLASS[itemSubclass] ?? null;
}

export function normalizeQuality(raw: string | null | undefined): string {
  if (!raw) return 'common';
  return raw.toLowerCase();
}

/** Inventory types the importer walks (covers all 19 GearSlots). */
export const IMPORT_INVENTORY_TYPES = [
  'HEAD',
  'NECK',
  'SHOULDER',
  'BODY',
  'CHEST',
  'WAIST',
  'LEGS',
  'FEET',
  'WRIST',
  'HAND',
  'FINGER',
  'TRINKET',
  'WEAPON',
  '2HWEAPON',
  'WEAPONMAINHAND',
  'WEAPONOFFHAND',
  'HOLDABLE',
  'SHIELD',
  'RANGED',
  'RANGEDRIGHT',
  'THROWN',
  'CLOAK',
  'TABARD',
  'ROBE',
] as const;
