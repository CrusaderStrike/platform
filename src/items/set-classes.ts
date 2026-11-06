/**
 * Manual Forever item-set → class map for sets whose pieces carry no
 * `preview_item.requirements.playable_classes` tag (verified live 2026-11-05
 * against static-forever-us).
 *
 * Seeded for:
 * - Naxxramas T3 (all 9 class sets) — pieces have no class tag
 * - Dungeon set 2 / T0.5 (all 9 class sets) — pieces have no class tag
 *
 * AQ40 tier / tokens and Zul'Gurub class sets *do* tag pieces, so they are
 * derived from item data at import time and are not listed here.
 */
import type { PlayableClass } from './playable-classes.js';

export const MANUAL_SET_CLASSES: Readonly<Record<number, readonly PlayableClass[]>> = {
  // --- Naxxramas T3 (verified untagged 2026-11-05) ---
  521: ['druid'], // Dreamwalker Raiment
  523: ['warrior'], // Dreadnaught's Battlegear
  524: ['rogue'], // Bonescythe Armor
  525: ['priest'], // Vestments of Faith
  526: ['mage'], // Frostfire Regalia
  527: ['shaman'], // The Earthshatterer
  528: ['paladin'], // Redemption Armor
  529: ['warlock'], // Plagueheart Raiment
  530: ['hunter'], // Cryptstalker Armor

  // --- Dungeon set 2 / T0.5 (verified untagged 2026-11-05) ---
  511: ['warrior'], // Battlegear of Heroism
  512: ['rogue'], // Darkmantle Armor
  513: ['druid'], // Feralheart Raiment
  514: ['priest'], // Vestments of the Virtuous
  515: ['hunter'], // Beastmaster Armor
  516: ['paladin'], // Soulforge Armor
  517: ['mage'], // Sorcerer's Regalia
  518: ['warlock'], // Deathmist Raiment
  519: ['shaman'], // The Five Thunders
};

export function manualClassesForSet(setId: number): PlayableClass[] | null {
  const row = MANUAL_SET_CLASSES[setId];
  return row ? [...row] : null;
}
