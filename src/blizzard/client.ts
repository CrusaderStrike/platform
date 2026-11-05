import type {
  BlizzardTokenResponse,
  BlizzardUserInfo,
  BlizzardWowAccountProfile,
  NormalizedCharacter,
} from './types.js';

export type BlizzardClientConfig = {
  clientId: string;
  clientSecret: string;
  region: 'us' | 'eu' | 'kr' | 'tw';
  authorizeUrl: string;
  tokenUrl: string;
  apiBaseUrl: string;
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
  fetchForeverCharacters(accessToken: string, region?: string): Promise<NormalizedCharacter[]>;
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
  region: 'us' | 'eu',
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
      const res = await fetch(`${cfg.apiBaseUrl.replace(/\/$/, '')}/oauth/userinfo`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      });
      // Battle.net also serves userinfo at oauth.battle.net/userinfo
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

    async fetchForeverCharacters(accessToken, region = cfg.region) {
      const ns = `profile-forever-${region}`;
      const url = `${cfg.apiBaseUrl.replace(/\/$/, '')}/profile/user/wow?namespace=${encodeURIComponent(ns)}&locale=en_US`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'Battlenet-Namespace': ns,
        },
      });
      if (res.status === 404) {
        // Empty Forever roster
        return [];
      }
      if (!res.ok) {
        const err = new Error(`blizzard_profile_${res.status}`);
        (err as Error & { status?: number }).status = res.status;
        throw err;
      }
      const body = (await res.json()) as BlizzardWowAccountProfile;
      const r = region === 'eu' ? 'eu' : 'us';
      return normalizeForeverCharacters(body, r);
    },
  };
}
