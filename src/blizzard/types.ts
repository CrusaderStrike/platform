export type BlizzardTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
};

export type BlizzardUserInfo = {
  id: number | string;
  battletag: string;
};

export type BlizzardWowCharacter = {
  id: number;
  name: string;
  surname?: string | null;
  realm?: { name?: string; id?: number; slug?: string } | null;
  playable_class?: { name?: string; id?: number };
  playable_race?: { name?: string; id?: number };
  faction?: { type?: string; name?: string };
  level?: number;
  protected_character?: { href?: string };
};

export type BlizzardWowAccountProfile = {
  wow_accounts?: Array<{
    id?: number;
    characters?: BlizzardWowCharacter[];
  }>;
};

export type NormalizedCharacter = {
  id: string;
  blizzardCharId: number;
  characterName: string;
  surname: string | null;
  realm: string | null;
  realmId: number | null;
  region: 'us' | 'eu';
  faction: 'alliance' | 'horde' | null;
  class: string | null;
  race: string | null;
  level: number | null;
  game: 'wow_forever';
  raw: unknown;
};
