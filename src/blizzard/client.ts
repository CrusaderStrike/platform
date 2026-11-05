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
  staticNamespace,
  type BlizzardRegion,
} from './regions.js';
import { sanitizeBlizzardIconUrl, iconNameFromUrl } from '../lib/icon-url.js';
import type {
  BlizzardItem,
  BlizzardItemMedia,
  BlizzardItemSearchPage,
} from './items.js';

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
    /** OIDC-style prompt forwarded to Battle.net when present. */
    prompt?: 'login';
  }): string;
  exchangeCode(args: { code: string; codeVerifier: string }): Promise<BlizzardTokenResponse>;
  fetchUserInfo(accessToken: string): Promise<BlizzardUserInfo>;
  /** Fetch Forever characters for one region. */
  fetchForeverCharacters(accessToken: string, region: BlizzardRegion): Promise<NormalizedCharacter[]>;
  /** Fetch Forever characters across all configured regions and merge. */
  fetchForeverCharactersAll(accessToken: string): Promise<NormalizedCharacter[]>;
  /**
   * Item Media icon HTTPS URL for Forever (`static-forever-{region}`).
   * Confirmed live 2026-11-04; never falls back to classic/retail namespaces.
   */
  fetchItemIconUrl(
    accessToken: string,
    itemId: number,
    region?: BlizzardRegion,
  ): Promise<{ iconUrl: string | null; iconName: string | null }>;
  /** Client-credentials token for Game Data (import / public catalog). */
  fetchClientCredentialsToken(): Promise<string>;
  /** Forever item detail. */
  fetchItem(
    accessToken: string,
    itemId: number,
    region?: BlizzardRegion,
  ): Promise<BlizzardItem | null>;
  /** Forever item search page filtered by inventory_type.type. */
  searchItems(
    accessToken: string,
    args: {
      inventoryType: string;
      page?: number;
      pageSize?: number;
      region?: BlizzardRegion;
    },
  ): Promise<BlizzardItemSearchPage>;
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
    buildAuthorizeUrl({ state, codeChallenge, scopes = ['wow.profile', 'openid'], prompt }) {
      const url = new URL(cfg.authorizeUrl);
      url.searchParams.set('client_id', cfg.clientId);
      url.searchParams.set('scope', scopes.join(' '));
      url.searchParams.set('state', state);
      url.searchParams.set('redirect_uri', cfg.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      if (prompt) url.searchParams.set('prompt', prompt);
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
    async fetchItemIconUrl(accessToken, itemId, region = cfg.region) {
      if (!isBlizzardRegion(region)) return { iconUrl: null, iconName: null };
      const ns = staticNamespace(region);
      const url = `${apiBaseFor(region)}/data/wow/media/item/${itemId}?namespace=${encodeURIComponent(ns)}&locale=en_US`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'Battlenet-Namespace': ns,
        },
      });
      if (res.status === 404) return { iconUrl: null, iconName: null };
      if (!res.ok) {
        const err = new Error(`blizzard_item_media_${res.status}`);
        (err as Error & { status?: number }).status = res.status;
        throw err;
      }
      const body = (await res.json()) as BlizzardItemMedia;
      const raw = body.assets?.find((a) => a.key === 'icon')?.value ?? null;
      const iconUrl = sanitizeBlizzardIconUrl(raw);
      return { iconUrl, iconName: iconNameFromUrl(iconUrl) };
    },

    async fetchClientCredentialsToken() {
      const body = new URLSearchParams({ grant_type: 'client_credentials' });
      const tok = await tokenRequest(body);
      return tok.access_token;
    },

    async fetchItem(accessToken, itemId, region = cfg.region) {
      if (!isBlizzardRegion(region)) return null;
      const ns = staticNamespace(region);
      const url = `${apiBaseFor(region)}/data/wow/item/${itemId}?namespace=${encodeURIComponent(ns)}&locale=en_US`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'Battlenet-Namespace': ns,
        },
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        const err = new Error(`blizzard_item_${res.status}`);
        (err as Error & { status?: number }).status = res.status;
        throw err;
      }
      return (await res.json()) as BlizzardItem;
    },

    async searchItems(accessToken, args) {
      const region = args.region ?? cfg.region;
      if (!isBlizzardRegion(region)) return { results: [], page: 1, pageCount: 0 };
      const ns = staticNamespace(region);
      const page = args.page ?? 1;
      const pageSize = args.pageSize ?? 100;
      const url = new URL(`${apiBaseFor(region)}/data/wow/search/item`);
      url.searchParams.set('namespace', ns);
      url.searchParams.set('locale', 'en_US');
      url.searchParams.set('orderby', 'id');
      url.searchParams.set('_page', String(page));
      url.searchParams.set('_pageSize', String(pageSize));
      url.searchParams.set('inventory_type.type', args.inventoryType);
      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'Battlenet-Namespace': ns,
        },
      });
      if (!res.ok) {
        const err = new Error(`blizzard_item_search_${res.status}`);
        (err as Error & { status?: number }).status = res.status;
        throw err;
      }
      return (await res.json()) as BlizzardItemSearchPage;
    },
  };
}
