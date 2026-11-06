import { describe, expect, it } from 'vitest';
import {
  classCanEquip,
  classCanEquipInOffHand,
  classAllowsGenericWeaponInOffHand,
  ALLOW_GENERIC_WEAPON_IN_OFFHAND,
  isJunkItemName,
  armorTypesForClass,
  weaponSubclassesForClass,
  canDualWield,
  canUseShield,
  canUseAmmo,
  relicSubclassForClass,
  WEAPON_SUB,
  ARMOR_SUB,
  type EquipItemView,
} from '../src/items/equip-rules.js';
import { PLAYABLE_CLASSES, normalizePlayableClass, normalizePlayableClassList } from '../src/items/playable-classes.js';
import { MANUAL_SET_CLASSES, manualClassesForSet } from '../src/items/set-classes.js';
import { playableClassesFromItem, itemSetIdFromItem } from '../src/items/import.js';
import type { BlizzardItem } from '../src/blizzard/items.js';

function item(partial: Partial<EquipItemView> & Pick<EquipItemView, 'name' | 'inventoryType'>): EquipItemView {
  return {
    itemClass: null,
    itemSubclass: null,
    armorType: null,
    allowedClasses: null,
    ...partial,
  };
}

describe('playable class helpers', () => {
  it('normalizes ids, names, and Classes: display strings', () => {
    expect(normalizePlayableClass(11)).toBe('druid');
    expect(normalizePlayableClass('Druid')).toBe('druid');
    expect(normalizePlayableClass('Classes: Druid')).toBe('druid');
    expect(normalizePlayableClass('cloth')).toBeNull();
    expect(normalizePlayableClassList(['Classes: Warrior, Paladin', 3])).toEqual([
      'hunter',
      'paladin',
      'warrior',
    ]);
  });

  it('parses playable_classes and set id from a Blizzard item payload', () => {
    const detail: BlizzardItem = {
      id: 21355,
      preview_item: {
        requirements: {
          playable_classes: {
            links: [{ id: 11, name: 'Druid' }],
            display_string: 'Classes: Druid',
          },
        },
        set: { item_set: { id: 493, name: 'Genesis Raiment' } },
      },
    };
    expect(playableClassesFromItem(detail)).toEqual(['druid']);
    expect(itemSetIdFromItem(detail)).toBe(493);
    expect(playableClassesFromItem({ id: 1 })).toEqual([]);
    expect(itemSetIdFromItem({ id: 1 })).toBeNull();
  });
});

describe('manual set-class map', () => {
  it('covers verified untagged T3 and T0.5 sets', () => {
    expect(manualClassesForSet(521)).toEqual(['druid']);
    expect(manualClassesForSet(523)).toEqual(['warrior']);
    expect(manualClassesForSet(527)).toEqual(['shaman']);
    expect(manualClassesForSet(530)).toEqual(['hunter']);
    expect(manualClassesForSet(511)).toEqual(['warrior']);
    expect(manualClassesForSet(515)).toEqual(['hunter']);
    expect(manualClassesForSet(493)).toBeNull(); // AQ40 Genesis is tagged on items
    expect(Object.keys(MANUAL_SET_CLASSES).length).toBe(18);
  });
});

describe('junk exclusion', () => {
  it('flags Monster, Test/(TEST), [PH], Deprecated, AHNQIRAJ TEST', () => {
    expect(isJunkItemName('Monster - Fire Arrow')).toBe(true);
    expect(isJunkItemName('Fast Test Ammo')).toBe(true);
    expect(isJunkItemName('Foo (TEST)')).toBe(true);
    expect(isJunkItemName('[PH] Cloth Helm')).toBe(true);
    expect(isJunkItemName('Deprecated Shoulders')).toBe(true);
    expect(isJunkItemName('AHNQIRAJ TEST Sword')).toBe(true);
    expect(isJunkItemName('Thunderfury, Blessed Blade of the Windseeker')).toBe(false);
    expect(isJunkItemName('Testament of Hope')).toBe(false);
  });
});

describe('armor tiers', () => {
  it('matches Classic Forever armor caps per class', () => {
    expect([...armorTypesForClass('warrior')].sort()).toEqual(['cloth', 'leather', 'mail', 'plate']);
    expect([...armorTypesForClass('hunter')].sort()).toEqual(['cloth', 'leather', 'mail']);
    expect([...armorTypesForClass('druid')].sort()).toEqual(['cloth', 'leather']);
    expect([...armorTypesForClass('mage')]).toEqual(['cloth']);
    for (const cls of PLAYABLE_CLASSES) {
      const plate = item({
        name: 'Plate Helm',
        inventoryType: 'HEAD',
        armorType: 'plate',
        itemClass: 4,
        itemSubclass: ARMOR_SUB.PLATE,
      });
      expect(classCanEquip(cls, plate)).toBe(cls === 'warrior' || cls === 'paladin');
    }
  });
});

describe('weapons, off-hand, shields, held', () => {
  const dagger = item({
    name: "Assassin's Blade",
    inventoryType: 'WEAPON',
    itemClass: 2,
    itemSubclass: WEAPON_SUB.DAGGER,
  });
  const mhOnly = item({
    name: "Doom's Edge",
    inventoryType: 'WEAPONMAINHAND',
    itemClass: 2,
    itemSubclass: WEAPON_SUB.AXE_1H,
  });
  const shield = item({
    name: 'Red Dragonscale Protector',
    inventoryType: 'SHIELD',
    itemClass: 4,
    itemSubclass: ARMOR_SUB.SHIELD,
  });
  const held = item({
    name: "Master Dragonslayer's Orb",
    inventoryType: 'HOLDABLE',
    itemClass: 4,
    itemSubclass: 0,
  });
  const wand = item({
    name: 'Nether Force Wand',
    inventoryType: 'RANGEDRIGHT',
    itemClass: 2,
    itemSubclass: WEAPON_SUB.WAND,
  });
  const staff = item({
    name: 'Staff of Dominance',
    inventoryType: 'TWOHWEAPON',
    itemClass: 2,
    itemSubclass: WEAPON_SUB.STAFF,
  });

  it('allows standard Classic weapon subclasses per class', () => {
    expect(classCanEquip('rogue', dagger)).toBe(true);
    expect(classCanEquip('mage', dagger)).toBe(true);
    expect(classCanEquip('paladin', dagger)).toBe(false);
    expect(classCanEquip('mage', wand)).toBe(true);
    expect(classCanEquip('warrior', wand)).toBe(false);
    expect(classCanEquip('druid', staff)).toBe(true);
    expect(weaponSubclassesForClass('hunter').has(WEAPON_SUB.BOW)).toBe(true);
  });

  it('gates generic WEAPON dual-wield and never allows MH-only / 2H in off_hand', () => {
    expect(ALLOW_GENERIC_WEAPON_IN_OFFHAND).toBe(true);
    expect(canDualWield('rogue')).toBe(true);
    expect(canDualWield('mage')).toBe(false);
    expect(classAllowsGenericWeaponInOffHand('rogue')).toBe(true);
    expect(classAllowsGenericWeaponInOffHand('mage')).toBe(false);
    expect(classCanEquipInOffHand('rogue', dagger)).toBe(true);
    expect(classCanEquipInOffHand('mage', dagger)).toBe(false);
    expect(classCanEquipInOffHand('warrior', mhOnly)).toBe(false);
    expect(classCanEquipInOffHand('warrior', staff)).toBe(false);
  });

  it('WEAPONOFFHAND and HOLDABLE are equippable by every class with no weapon-skill check', () => {
    const ohSword = item({
      name: 'Offhand Sword of the Mage',
      inventoryType: 'WEAPONOFFHAND',
      itemClass: 2,
      itemSubclass: WEAPON_SUB.SWORD_1H,
    });
    const ohFist = item({
      name: 'Offhand Fist of the Priest',
      inventoryType: 'WEAPONOFFHAND',
      itemClass: 2,
      itemSubclass: WEAPON_SUB.FIST,
    });
    // Fist is not on priest/mage weapon lists; WEAPONOFFHAND still allowed.
    expect(weaponSubclassesForClass('priest').has(WEAPON_SUB.FIST)).toBe(false);
    expect(weaponSubclassesForClass('mage').has(WEAPON_SUB.FIST)).toBe(false);
    for (const cls of PLAYABLE_CLASSES) {
      expect(classCanEquip(cls, held)).toBe(true);
      expect(classCanEquip(cls, ohSword)).toBe(true);
      expect(classCanEquip(cls, ohFist)).toBe(true);
      expect(classCanEquipInOffHand(cls, held)).toBe(true);
      expect(classCanEquipInOffHand(cls, ohSword)).toBe(true);
      expect(classCanEquipInOffHand(cls, ohFist)).toBe(true);
    }
    // Mage with an off-hand sword / priest with an off-hand fist (Drew examples).
    expect(classCanEquipInOffHand('mage', ohSword)).toBe(true);
    expect(classCanEquipInOffHand('priest', ohFist)).toBe(true);
  });

  it('shields only for warrior/paladin/shaman; held for all', () => {
    expect(canUseShield('warrior')).toBe(true);
    expect(canUseShield('druid')).toBe(false);
    expect(classCanEquip('shaman', shield)).toBe(true);
    expect(classCanEquip('rogue', shield)).toBe(false);
    expect(classCanEquipInOffHand('shaman', shield)).toBe(true);
    expect(classCanEquipInOffHand('mage', shield)).toBe(false);
    for (const cls of PLAYABLE_CLASSES) {
      expect(classCanEquip(cls, held)).toBe(true);
    }
  });
});

describe('ranged, relics, ammo', () => {
  it('assigns idols/librams/totems and ranged weapons by class', () => {
    expect(relicSubclassForClass('druid')).toBe(ARMOR_SUB.IDOL);
    expect(relicSubclassForClass('paladin')).toBe(ARMOR_SUB.LIBRAM);
    expect(relicSubclassForClass('shaman')).toBe(ARMOR_SUB.TOTEM);
    expect(relicSubclassForClass('mage')).toBeNull();
    const idol = item({
      name: 'Idol of Ferocity',
      inventoryType: 'RELIC',
      itemClass: 4,
      itemSubclass: ARMOR_SUB.IDOL,
    });
    const libram = item({
      name: 'Libram of Truth',
      inventoryType: 'RELIC',
      itemClass: 4,
      itemSubclass: ARMOR_SUB.LIBRAM,
    });
    expect(classCanEquip('druid', idol)).toBe(true);
    expect(classCanEquip('paladin', idol)).toBe(false);
    expect(classCanEquip('paladin', libram)).toBe(true);
    const gun = item({
      name: 'Xorothian Firestick',
      inventoryType: 'RANGEDRIGHT',
      itemClass: 2,
      itemSubclass: WEAPON_SUB.GUN,
    });
    expect(classCanEquip('hunter', gun)).toBe(true);
    expect(classCanEquip('priest', gun)).toBe(false);
  });

  it('ammo only for hunter/rogue/warrior', () => {
    expect(canUseAmmo('hunter')).toBe(true);
    expect(canUseAmmo('mage')).toBe(false);
    const arrow = item({
      name: 'Rough Arrow',
      inventoryType: 'AMMO',
      itemClass: 6,
      itemSubclass: 2,
    });
    expect(classCanEquip('hunter', arrow)).toBe(true);
    expect(classCanEquip('warlock', arrow)).toBe(false);
  });
});

describe('set ownership via allowed_classes', () => {
  it('rejects other classes when a restriction is present', () => {
    const genesis = item({
      name: 'Genesis Boots',
      inventoryType: 'FEET',
      armorType: 'leather',
      itemClass: 4,
      itemSubclass: ARMOR_SUB.LEATHER,
      allowedClasses: ['druid'],
    });
    expect(classCanEquip('druid', genesis)).toBe(true);
    expect(classCanEquip('mage', genesis)).toBe(false);
    expect(classCanEquip('paladin', genesis)).toBe(false);
  });
});
