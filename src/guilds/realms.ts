/**
 * Forever "realm" allowlist for public guild URLs.
 *
 * WoW Forever is realmless: players pick a ruleset (Normal / PvP / Roleplaying /
 * Roleplay-PvP / Hardcore) per region, not a classic realm list. Ruleset names
 * repeat across regions, so they are NOT globally unique — uniqueness is
 * (region, ruleset). Our public path `/g/{realm_slug}/{guild_slug}` has no
 * region segment; we still require realm_slug ∈ this allowlist and enforce
 * UNIQUE (realm_slug, guild_slug) ourselves.
 *
 * Mock Blizzard fixtures use Emberfall / Everlook; those stay for tests + demos.
 */

export type ForeverRealm = {
  slug: string;
  name: string;
};

const REALMS: ForeverRealm[] = [
  // Rulesets (Blizzard Forever launch set)
  { slug: 'normal', name: 'Normal' },
  { slug: 'pvp', name: 'PvP' },
  { slug: 'roleplaying', name: 'Roleplaying' },
  { slug: 'roleplay-pvp', name: 'Roleplay-PvP' },
  { slug: 'hardcore', name: 'Hardcore' },
  // Mock / fixture realms used by Blizzard mock + tests
  { slug: 'emberfall', name: 'Emberfall' },
  { slug: 'everlook', name: 'Everlook' },
];

const BY_SLUG = new Map(REALMS.map((r) => [r.slug, r]));

export function listForeverRealms(): ForeverRealm[] {
  return REALMS.slice();
}

export function getForeverRealm(slug: string): ForeverRealm | undefined {
  return BY_SLUG.get(slug.toLowerCase());
}

export function isForeverRealmSlug(slug: string): boolean {
  return BY_SLUG.has(slug.toLowerCase());
}

/** kebab-case slug shape shared by realm_slug and guild_slug. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSlug(value: string, max = 48): boolean {
  return value.length >= 1 && value.length <= max && SLUG_RE.test(value);
}
