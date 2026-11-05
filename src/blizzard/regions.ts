export const BLIZZARD_REGION_CODES = ['us', 'eu', 'kr', 'tw'] as const;
export type BlizzardRegion = (typeof BLIZZARD_REGION_CODES)[number];

export function isBlizzardRegion(value: string): value is BlizzardRegion {
  return (BLIZZARD_REGION_CODES as readonly string[]).includes(value);
}

/** Per-region Game Data / Profile API host (Forever uses the same host pattern). */
export function apiBaseUrlForRegion(region: BlizzardRegion): string {
  return `https://${region}.api.blizzard.com`;
}

/** OAuth authorize/token hosts. us/eu/kr/tw share the global Battle.net OAuth host. */
export function oauthAuthorizeUrlForRegion(_region: BlizzardRegion): string {
  return 'https://oauth.battle.net/authorize';
}

export function oauthTokenUrlForRegion(_region: BlizzardRegion): string {
  return 'https://oauth.battle.net/token';
}

export function profileNamespace(region: BlizzardRegion): string {
  return `profile-forever-${region}`;
}

export function parseRegionsList(raw: string | undefined | null): BlizzardRegion[] {
  const input = (raw ?? 'us').trim() || 'us';
  const parts = input.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error("BLIZZARD_REGIONS must list at least one of: us, eu, kr, tw");
  }
  const out: BlizzardRegion[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    if (!isBlizzardRegion(p)) {
      throw new Error(
        `Unsupported Blizzard region '${p}'. Allowed: ${BLIZZARD_REGION_CODES.join(', ')}`,
      );
    }
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}
