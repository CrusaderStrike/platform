import type {
  BlizzardTokenResponse,
  BlizzardUserInfo,
  BlizzardWowAccountProfile,
  NormalizedCharacter,
} from './types.js';
import {
  apiBaseUrlForRegion,
  isBlizzardRegion,
  profileNamespace,
  type BlizzardRegion,
} from './regions.js';

export type BlizzardClientConfig = {
  clientId: string;
  clientSecret: string;
  /** Primary region (OAuth host selection). */
  region: BlizzardRegion;
  /** Regions to pull Forever characters from on login/refresh. */
  regions: BlizzardRegion[];
  authorizeUrl: string;
  tokenUrl: string;
  /**
   * Optional single API base (tests/mock). When unset, each region uses
   * https://{region}.api.blizzard.com.
   */
  apiBaseUrl?: string;
  redirectUri: string;
};

export type BlizzardClient = {
  buildAuthorizeUrl(args: {
    state: string;
    codeChallenge: string;
    scopes?: string[];
  }): string;
  exchangeCode(args: { code: string; codeVerifier: string }): Promise<BlizzardTokenResponse>;
  fetchUserInfo(accessToken: string): Promise<BlizzardUserInfo>;
  /** Fetch Forever characters for one region. */
  fetchForeverCharacters(accessToken: string, region: BlizzardRegion): Promise<NormalizedCharacter[]>;
  /** Fetch Forever characters across all configured regions and merge. */
  fetchForeverCharactersAll(accessToken: string): Promise<NormalizedCharacter[]>;
  /**
   * Item Media icon HTTPS URL for Forever.
   * Currently always returns null: Blizzard has not published an official Forever
   * static namespace that pairs with profile-forever-{region}. Community probes
   * suggest static-forever-{region}, but that is unconfirmed — do not call Item
   * Media until develop.battle.net documents it.
   * TODO(forever-static): resume GET /data/wow/media/item/{id} with the official
   * static-forever-{region} (or whatever Blizzard publishes) once confirmed.
   */
  fetchItemIconUrl(
    accessToken: string,
    itemId: number,
    region?: BlizzardRegion,
  ): Promise<{ iconUrl: string | null; iconName: string | null }>;
};

function mapFaction(raw?: string | null): 'alliance' | 'horde' | null {
  if (!raw) return null;
  const t = raw.toLowerCase();
  if (t === 'alliance' || t === 'horde') return t;
  return null;
}

function opaqueId(region: string, blizzardId: number): string {
  return `ch_${region}_${blizzardId}`;
}

export function normalizeForeverCharacters(
  profile: BlizzardWowAccountProfile,
  region: BlizzardRegion,
): NormalizedCharacter[] {
  const out: NormalizedCharacter[] = [];
  for (const account of profile.wow_accounts ?? []) {
    for (const c of account.characters ?? []) {
      if (!c?.id || !c.name) continue;
      out.push({
        id: opaqueId(region, c.id),
        blizzardCharId: c.id,
        characterName: c.name,
        surname: c.surname ?? null,
        realm: c.realm?.name ?? null,
        realmId: c.realm?.id ?? null,
        region,
        faction: mapFaction(c.faction?.type ?? c.faction?.name ?? null),
        class: c.playable_class?.name ?? null,
        race: c.playable_race?.name ?? null,
        level: c.level ?? null,
        game: 'wow_forever',
        raw: c,
      });
    }
  }
  return out;
}

export function createBlizzardClient(cfg: BlizzardClientConfig): BlizzardClient {
  const regions = cfg.regions.length ? cfg.regions : [cfg.region];

  async function tokenRequest(body: URLSearchParams): Promise<BlizzardTokenResponse> {
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    const res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`blizzard_token_${res.status}:${text.slice(0, 200)}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return (await res.json()) as BlizzardTokenResponse;
  }

  function apiBaseFor(region: BlizzardRegion): string {
    if (cfg.apiBaseUrl) return cfg.apiBaseUrl.replace(/\/$/, '');
    return apiBaseUrlForRegion(region);
  }

  async function fetchForeverCharacters(
    accessToken: string,
    region: BlizzardRegion,
  ): Promise<NormalizedCharacter[]> {
    if (!isBlizzardRegion(region)) return [];
    const ns = profileNamespace(region);
    const url = `${apiBaseFor(region)}/profile/user/wow?namespace=${encodeURIComponent(ns)}&locale=en_US`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Battlenet-Namespace': ns,
      },
    });
    if (res.status === 404) return [];
    if (!res.ok) {
      const err = new Error(`blizzard_profile_${res.status}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    const body = (await res.json()) as BlizzardWowAccountProfile;
    return normalizeForeverCharacters(body, region);
  }

  return {
    buildAuthorizeUrl({ state, codeChallenge, scopes = ['wow.profile', 'openid'] }) {
      const url = new URL(cfg.authorizeUrl);
      url.searchParams.set('client_id', cfg.clientId);
      url.searchParams.set('scope', scopes.join(' '));
      url.searchParams.set('state', state);
      url.searchParams.set('redirect_uri', cfg.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return url.toString();
    },

    exchangeCode({ code, codeVerifier }) {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: cfg.redirectUri,
        code_verifier: codeVerifier,
      });
      return tokenRequest(body);
    },

    async fetchUserInfo(accessToken) {
      const base = apiBaseFor(cfg.region);
      const res = await fetch(`${base}/oauth/userinfo`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
      if (res.status === 404) {
        const alt = await fetch('https://oauth.battle.net/userinfo', {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        });
        if (!alt.ok) {
          const err = new Error(`blizzard_userinfo_${alt.status}`);
          (err as Error & { status?: number }).status = alt.status;
          throw err;
        }
        return (await alt.json()) as BlizzardUserInfo;
      }
      if (!res.ok) {
        const err = new Error(`blizzard_userinfo_${res.status}`);
        (err as Error & { status?: number }).status = res.status;
        throw err;
      }
      return (await res.json()) as BlizzardUserInfo;
    },

    fetchForeverCharacters,

    async fetchForeverCharactersAll(accessToken) {
      const all: NormalizedCharacter[] = [];
      const seen = new Set<string>();
      for (const region of regions) {
        const chars = await fetchForeverCharacters(accessToken, region);
        for (const c of chars) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          all.push(c);
        }
      }
      return all;
    },
    async fetchItemIconUrl(_accessToken, _itemId, _region = cfg.region) {
      // Skip Item Media until Blizzard publishes an official Forever static namespace
      // (community probes name static-forever-{region}; unconfirmed — do not guess).
      // TODO(forever-static): call GET /data/wow/media/item/{id}?namespace=static-forever-{region}
      // once develop.battle.net documents it; sanitize with sanitizeBlizzardIconUrl.
      void _accessToken;
      void _itemId;
      void _region;
      return { iconUrl: null, iconName: null };
    },
  };
}
