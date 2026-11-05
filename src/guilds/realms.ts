/**
 * Forever "realm" allowlist for public guild URLs, keyed by region.
 *
 * WoW Forever is realmless: players pick a ruleset (Normal / PvP / Roleplaying /
 * Roleplay-PvP / Hardcore) per region. Ruleset names repeat across regions, so
 * public identity is (region, realm_slug, guild_slug).
 *
 * Mock Blizzard fixtures use Emberfall / Everlook (US only for tests/demos).
 */

import type { BlizzardRegion } from '../blizzard/regions.js';
import { BLIZZARD_REGION_CODES } from '../blizzard/regions.js';

export type ForeverRealm = {
  slug: string;
  name: string;
};

const RULESETS: ForeverRealm[] = [
  { slug: 'normal', name: 'Normal' },
  { slug: 'pvp', name: 'PvP' },
  { slug: 'roleplaying', name: 'Roleplaying' },
  { slug: 'roleplay-pvp', name: 'Roleplay-PvP' },
  { slug: 'hardcore', name: 'Hardcore' },
];

const US_MOCKS: ForeverRealm[] = [
  { slug: 'emberfall', name: 'Emberfall' },
  { slug: 'everlook', name: 'Everlook' },
];

function buildAllowlist(): Map<BlizzardRegion, Map<string, ForeverRealm>> {
  const out = new Map<BlizzardRegion, Map<string, ForeverRealm>>();
  for (const region of BLIZZARD_REGION_CODES) {
    const m = new Map<string, ForeverRealm>();
    for (const r of RULESETS) m.set(r.slug, r);
    if (region === 'us') {
      for (const r of US_MOCKS) m.set(r.slug, r);
    }
    out.set(region, m);
  }
  return out;
}

const BY_REGION = buildAllowlist();

export function listForeverRealms(region: BlizzardRegion): ForeverRealm[] {
  return [...(BY_REGION.get(region)?.values() ?? [])];
}

export function getForeverRealm(
  region: BlizzardRegion,
  slug: string,
): ForeverRealm | undefined {
  return BY_REGION.get(region)?.get(slug.toLowerCase());
}

export function isForeverRealmSlug(region: BlizzardRegion, slug: string): boolean {
  return BY_REGION.get(region)?.has(slug.toLowerCase()) ?? false;
}

/** True if slug appears in any region's allowlist (list filter without region). */
export function isForeverRealmSlugAny(slug: string): boolean {
  const s = slug.toLowerCase();
  for (const m of BY_REGION.values()) {
    if (m.has(s)) return true;
  }
  return false;
}

/** kebab-case slug shape shared by realm_slug and guild_slug. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSlug(value: string, max = 48): boolean {
  return value.length >= 1 && value.length <= max && SLUG_RE.test(value);
}
