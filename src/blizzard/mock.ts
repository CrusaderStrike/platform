import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { BlizzardClientConfig } from './client.js';
import { createBlizzardClient, type BlizzardClient } from './client.js';

export type MockBlizzardOptions = {
  /** Force token/profile calls to fail with 5xx. */
  failUpstream?: boolean;
  /** Empty Forever roster. */
  emptyRoster?: boolean;
};

type PendingAuth = {
  codeChallenge: string;
  redirectUri: string;
};

const FIXTURE_CHARS = [
  {
    id: 1001,
    name: 'Lightbringer',
    surname: 'Dawnmantle',
    realm: { name: 'Emberfall', id: 1, slug: 'emberfall' },
    playable_class: { name: 'Paladin', id: 2 },
    playable_race: { name: 'Human', id: 1 },
    faction: { type: 'ALLIANCE', name: 'Alliance' },
    level: 60,
  },
  {
    id: 1002,
    name: 'Ashenvow',
    surname: null,
    realm: { name: 'Emberfall', id: 1, slug: 'emberfall' },
    playable_class: { name: 'Priest', id: 5 },
    playable_race: { name: 'Dwarf', id: 3 },
    faction: { type: 'ALLIANCE', name: 'Alliance' },
    level: 60,
  },
  {
    id: 1003,
    name: 'Thornquill',
    surname: 'Briarhide',
    realm: null,
    playable_class: { name: 'Druid', id: 11 },
    playable_race: { name: 'Tauren', id: 6 },
    faction: { type: 'HORDE', name: 'Horde' },
    level: 52,
  },
  {
    id: 1004,
    name: 'Grimlantern',
    playable_class: { name: 'Warlock', id: 9 },
    playable_race: { name: 'Undead', id: 5 },
    faction: { type: 'HORDE', name: 'Horde' },
    level: 38,
  },
  // Non-Forever decoy — mock profile endpoint only serves Forever namespace.
  {
    id: 9001,
    name: 'Filtered',
    surname: null,
    realm: { name: 'Emberfall', id: 1 },
    playable_class: { name: 'Mage', id: 8 },
    playable_race: { name: 'Gnome', id: 7 },
    faction: { type: 'ALLIANCE', name: 'Alliance' },
    level: 10,
    _game: 'other',
  },
];

const FIXTURE_FOREVER_ITEMS = [
  {
    id: 19019,
    name: 'Thunderfury, Blessed Blade of the Windseeker',
    inventory_type: { type: 'WEAPON', name: 'One-Hand' },
    quality: { type: 'LEGENDARY', name: 'Legendary' },
    level: 80,
    required_level: 60,
    item_class: { id: 2, name: 'Weapon' },
    item_subclass: { id: 7, name: 'Sword' },
    preview_item: {
      stats: [
        { type: { type: 'AGILITY', name: 'Agility' }, value: 44 },
        { type: { type: 'STAMINA', name: 'Stamina' }, value: 22 },
      ],
    },
    icon: 'inv_sword_39',
  },
  {
    id: 16846,
    name: "Giantstalker's Helmet",
    inventory_type: { type: 'HEAD', name: 'Head' },
    quality: { type: 'EPIC', name: 'Epic' },
    level: 66,
    required_level: 60,
    item_class: { id: 4, name: 'Armor' },
    item_subclass: { id: 3, name: 'Mail' },
    preview_item: {
      stats: [{ type: { type: 'AGILITY', name: 'Agility' }, value: 23 }],
    },
    icon: 'inv_helmet_05',
  },
  {
    id: 16914,
    name: 'Netherwind Crown',
    inventory_type: { type: 'HEAD', name: 'Head' },
    quality: { type: 'EPIC', name: 'Epic' },
    level: 76,
    required_level: 60,
    item_class: { id: 4, name: 'Armor' },
    item_subclass: { id: 1, name: 'Cloth' },
    preview_item: {
      stats: [{ type: { type: 'INTELLECT', name: 'Intellect' }, value: 30 }],
    },
    icon: 'inv_crown_01',
  },
  {
    id: 18813,
    name: 'Ring of Binding',
    inventory_type: { type: 'FINGER', name: 'Finger' },
    quality: { type: 'EPIC', name: 'Epic' },
    level: 73,
    required_level: 60,
    item_class: { id: 4, name: 'Armor' },
    item_subclass: { id: 0, name: 'Miscellaneous' },
    preview_item: { stats: [] },
    icon: 'inv_jewelry_ring_13',
  },
  {
    id: 12345,
    name: 'Test Helm of Emberfall',
    inventory_type: { type: 'HEAD', name: 'Head' },
    quality: { type: 'RARE', name: 'Rare' },
    level: 40,
    required_level: 35,
    item_class: { id: 4, name: 'Armor' },
    item_subclass: { id: 4, name: 'Plate' },
    preview_item: {
      stats: [{ type: { type: 'STRENGTH', name: 'Strength' }, value: 12 }],
    },
    icon: 'inv_helmet_03',
  },
  // AQ40 Genesis (Druid) — tagged class set
  {
    id: 21355,
    name: 'Genesis Boots',
    inventory_type: { type: 'FEET', name: 'Feet' },
    quality: { type: 'EPIC', name: 'Epic' },
    level: 78,
    required_level: 60,
    item_class: { id: 4, name: 'Armor' },
    item_subclass: { id: 2, name: 'Leather' },
    preview_item: {
      stats: [{ type: { type: 'INTELLECT', name: 'Intellect' }, value: 20 }],
      requirements: {
        playable_classes: {
          links: [{ id: 11, name: 'Druid' }],
          display_string: 'Classes: Druid',
        },
      },
      set: { item_set: { id: 493, name: 'Genesis Raiment' } },
    },
    icon: 'inv_boots_08',
  },
  {
    id: 21353,
    name: 'Genesis Helm',
    inventory_type: { type: 'HEAD', name: 'Head' },
    quality: { type: 'EPIC', name: 'Epic' },
    level: 81,
    required_level: 60,
    item_class: { id: 4, name: 'Armor' },
    item_subclass: { id: 2, name: 'Leather' },
    preview_item: {
      requirements: {
        playable_classes: {
          links: [{ id: 11, name: 'Druid' }],
          display_string: 'Classes: Druid',
        },
      },
      set: { item_set: { id: 493, name: 'Genesis Raiment' } },
    },
    icon: 'inv_helmet_42',
  },
  // T3 Dreamwalker — untagged; class from manual map
  {
    id: 22490,
    name: 'Dreamwalker Headpiece',
    inventory_type: { type: 'HEAD', name: 'Head' },
    quality: { type: 'EPIC', name: 'Epic' },
    level: 88,
    required_level: 60,
    item_class: { id: 4, name: 'Armor' },
    item_subclass: { id: 2, name: 'Leather' },
    preview_item: {
      set: { item_set: { id: 521, name: 'Dreamwalker Raiment' } },
    },
    icon: 'inv_helmet_15',
  },
  {
    id: 22488,
    name: 'Dreamwalker Tunic',
    inventory_type: { type: 'CHEST', name: 'Chest' },
    quality: { type: 'EPIC', name: 'Epic' },
    level: 92,
    required_level: 60,
    item_class: { id: 4, name: 'Armor' },
    item_subclass: { id: 2, name: 'Leather' },
    preview_item: {
      set: { item_set: { id: 521, name: 'Dreamwalker Raiment' } },
    },
    icon: 'inv_chest_leather_08',
  },
  // T3 Dreadnaught — untagged warrior
  {
    id: 22418,
    name: 'Dreadnaught Helmet',
    inventory_type: { type: 'HEAD', name: 'Head' },
    quality: { type: 'EPIC', name: 'Epic' },
    level: 88,
    required_level: 60,
    item_class: { id: 4, name: 'Armor' },
    item_subclass: { id: 4, name: 'Plate' },
    preview_item: {
      set: { item_set: { id: 523, name: "Dreadnaught's Battlegear" } },
    },
    icon: 'inv_helmet_58',
  },
  // Weapons / off-hand / ranged / ammo / relics / junk
  {
    id: 1935,
    name: 'Assassin\'s Blade',
    inventory_type: { type: 'WEAPON', name: 'One-Hand' },
    quality: { type: 'RARE', name: 'Rare' },
    level: 24,
    required_level: 19,
    item_class: { id: 2, name: 'Weapon' },
    item_subclass: { id: 15, name: 'Dagger' },
    preview_item: { stats: [] },
    icon: 'inv_weapon_shortblade_15',
  },
  {
    id: 19362,
    name: 'Doom\'s Edge',
    inventory_type: { type: 'WEAPONMAINHAND', name: 'Main Hand' },
    quality: { type: 'EPIC', name: 'Epic' },
    level: 70,
    required_level: 60,
    item_class: { id: 2, name: 'Weapon' },
    item_subclass: { id: 0, name: 'Axe' },
    preview_item: { stats: [] },
    icon: 'inv_axe_15',
  },
  {
    id: 19348,
    name: 'Red Dragonscale Protector',
    inventory_type: { type: 'SHIELD', name: 'Shield' },
    quality: { type: 'EPIC', name: 'Epic' },
    level: 74,
    required_level: 60,
    item_class: { id: 4, name: 'Armor' },
    item_subclass: { id: 6, name: 'Shield' },
    preview_item: { stats: [] },
    icon: 'inv_shield_18',
  },
  {
    id: 19366,
    name: 'Master Dragonslayer\'s Orb',
    inventory_type: { type: 'HOLDABLE', name: 'Held In Off-hand' },
    quality: { type: 'EPIC', name: 'Epic' },
    level: 83,
    required_level: 60,
    item_class: { id: 4, name: 'Armor' },
    item_subclass: { id: 0, name: 'Miscellaneous' },
    preview_item: { stats: [] },
    icon: 'inv_misc_orb_03',
  },
  {
    id: 18737,
    name: 'Bone Slicing Hatchet',
    inventory_type: { type: 'WEAPONOFFHAND', name: 'Off Hand' },
    quality: { type: 'RARE', name: 'Rare' },
    level: 62,
    required_level: 57,
    item_class: { id: 2, name: 'Weapon' },
    item_subclass: { id: 0, name: 'Axe' },
    preview_item: { stats: [] },
    icon: 'inv_axe_11',
  },
  {
    id: 17074,
    name: 'Shadowstrike',
    inventory_type: { type: 'TWOHWEAPON', name: 'Two-Hand' },
    quality: { type: 'EPIC', name: 'Epic' },
    level: 63,
    required_level: 58,
    item_class: { id: 2, name: 'Weapon' },
    item_subclass: { id: 6, name: 'Polearm' },
    preview_item: { stats: [] },
    icon: 'inv_spear_08',
  },
  {
    id: 18755,
    name: 'Xorothian Firestick',
    inventory_type: { type: 'RANGEDRIGHT', name: 'Gun' },
    quality: { type: 'RARE', name: 'Rare' },
    level: 62,
    required_level: 57,
    item_class: { id: 2, name: 'Weapon' },
    item_subclass: { id: 3, name: 'Gun' },
    preview_item: { stats: [] },
    icon: 'inv_weapon_rifle_07',
  },
  {
    id: 18842,
    name: 'Staff of Dominance',
    inventory_type: { type: 'TWOHWEAPON', name: 'Two-Hand' },
    quality: { type: 'EPIC', name: 'Epic' },
    level: 70,
    required_level: 60,
    item_class: { id: 2, name: 'Weapon' },
    item_subclass: { id: 10, name: 'Staff' },
    preview_item: { stats: [] },
    icon: 'inv_staff_32',
  },
  {
    id: 11263,
    name: 'Nether Force Wand',
    inventory_type: { type: 'RANGEDRIGHT', name: 'Wand' },
    quality: { type: 'RARE', name: 'Rare' },
    level: 40,
    required_level: 35,
    item_class: { id: 2, name: 'Weapon' },
    item_subclass: { id: 19, name: 'Wand' },
    preview_item: { stats: [] },
    icon: 'inv_wand_07',
  },
  {
    id: 22397,
    name: 'Idol of Ferocity',
    inventory_type: { type: 'RELIC', name: 'Relic' },
    quality: { type: 'RARE', name: 'Rare' },
    level: 62,
    required_level: 57,
    item_class: { id: 4, name: 'Armor' },
    item_subclass: { id: 8, name: 'Idol' },
    preview_item: { stats: [] },
    icon: 'inv_relics_idolofferocity',
  },
  {
    id: 22398,
    name: 'Idol of Rejuvenation',
    inventory_type: { type: 'RELIC', name: 'Relic' },
    quality: { type: 'RARE', name: 'Rare' },
    level: 62,
    required_level: 57,
    item_class: { id: 4, name: 'Armor' },
    item_subclass: { id: 8, name: 'Idol' },
    preview_item: { stats: [] },
    icon: 'inv_relics_idolofrejuvenation',
  },
  {
    id: 22399,
    name: 'Libram of Truth',
    inventory_type: { type: 'RELIC', name: 'Relic' },
    quality: { type: 'RARE', name: 'Rare' },
    level: 62,
    required_level: 57,
    item_class: { id: 4, name: 'Armor' },
    item_subclass: { id: 7, name: 'Libram' },
    preview_item: { stats: [] },
    icon: 'inv_relics_libramoftruth',
  },
  {
    id: 22396,
    name: 'Totem of Life',
    inventory_type: { type: 'RELIC', name: 'Relic' },
    quality: { type: 'RARE', name: 'Rare' },
    level: 62,
    required_level: 57,
    item_class: { id: 4, name: 'Armor' },
    item_subclass: { id: 9, name: 'Totem' },
    preview_item: { stats: [] },
    icon: 'inv_relics_totemoflife',
  },
  {
    id: 2512,
    name: 'Rough Arrow',
    inventory_type: { type: 'AMMO', name: 'Ammo' },
    quality: { type: 'COMMON', name: 'Common' },
    level: 5,
    required_level: 1,
    item_class: { id: 6, name: 'Projectile' },
    item_subclass: { id: 2, name: 'Arrow' },
    preview_item: { stats: [] },
    icon: 'inv_ammo_arrow_01',
  },
  {
    id: 2516,
    name: 'Light Shot',
    inventory_type: { type: 'AMMO', name: 'Ammo' },
    quality: { type: 'COMMON', name: 'Common' },
    level: 5,
    required_level: 1,
    item_class: { id: 6, name: 'Projectile' },
    item_subclass: { id: 3, name: 'Bullet' },
    preview_item: { stats: [] },
    icon: 'inv_ammo_bullet_02',
  },
  {
    id: 19082,
    name: 'Monster - Fire Arrow',
    inventory_type: { type: 'AMMO', name: 'Ammo' },
    quality: { type: 'COMMON', name: 'Common' },
    level: 1,
    required_level: 0,
    item_class: { id: 6, name: 'Projectile' },
    item_subclass: { id: 2, name: 'Arrow' },
    preview_item: { stats: [] },
    icon: 'inv_ammo_arrow_02',
  },
  {
    id: 19286,
    name: 'Fast Test Ammo',
    inventory_type: { type: 'AMMO', name: 'Ammo' },
    quality: { type: 'COMMON', name: 'Common' },
    level: 1,
    required_level: 0,
    item_class: { id: 6, name: 'Projectile' },
    item_subclass: { id: 2, name: 'Arrow' },
    preview_item: { stats: [] },
    icon: 'inv_ammo_arrow_02',
  },
  {
    id: 99901,
    name: '[PH] Deprecated Cloth Helm',
    inventory_type: { type: 'HEAD', name: 'Head' },
    quality: { type: 'POOR', name: 'Poor' },
    level: 1,
    required_level: 0,
    item_class: { id: 4, name: 'Armor' },
    item_subclass: { id: 1, name: 'Cloth' },
    preview_item: { stats: [] },
    icon: 'inv_helmet_01',
  },
  {
    id: 99902,
    name: 'AHNQIRAJ TEST Sword',
    inventory_type: { type: 'WEAPON', name: 'One-Hand' },
    quality: { type: 'POOR', name: 'Poor' },
    level: 1,
    required_level: 0,
    item_class: { id: 2, name: 'Weapon' },
    item_subclass: { id: 7, name: 'Sword' },
    preview_item: { stats: [] },
    icon: 'inv_sword_04',
  },
];

const FIXTURE_ITEM_SETS = [
  {
    id: 493,
    name: 'Genesis Raiment',
    items: [
      { id: 21355, name: 'Genesis Boots' },
      { id: 21353, name: 'Genesis Helm' },
      { id: 21354, name: 'Genesis Shoulderpads' },
      { id: 21356, name: 'Genesis Trousers' },
      { id: 21357, name: 'Genesis Vest' },
    ],
    effects: [{ display_string: '(3) Set: Increased Defense +15.', required_count: 3 }],
  },
  {
    id: 521,
    name: 'Dreamwalker Raiment',
    items: [
      { id: 22490, name: 'Dreamwalker Headpiece' },
      { id: 22488, name: 'Dreamwalker Tunic' },
      { id: 22492, name: 'Dreamwalker Boots' },
    ],
    effects: [{ display_string: 'Set: Your Rejuvenation ticks have a chance to restore mana.', required_count: 2 }],
  },
  {
    id: 523,
    name: "Dreadnaught's Battlegear",
    items: [
      { id: 22418, name: 'Dreadnaught Helmet' },
      { id: 22416, name: 'Dreadnaught Breastplate' },
    ],
    effects: [{ display_string: 'Set: Increases your chance to dodge.', required_count: 2 }],
  },
];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export type MockBlizzard = {
  server: Server;
  baseUrl: string;
  authorizeUrl: string;
  tokenUrl: string;
  apiBaseUrl: string;
  client: BlizzardClient;
  config: BlizzardClientConfig;
  options: MockBlizzardOptions;
  /** Simulate user consent; returns redirect Location the browser would follow. */
  completeLogin(args: {
    authorizeUrl: string;
    outcome: 'ok' | 'access_denied';
  }): { redirectTo: string };
  close(): Promise<void>;
};

export async function startMockBlizzard(
  opts: MockBlizzardOptions = {},
): Promise<MockBlizzard> {
  const pending = new Map<string, PendingAuth>();
  const codes = new Map<string, { verifierChallenge: string; redirectUri: string }>();
  const tokens = new Map<string, { access: string }>();
  const options: MockBlizzardOptions = { ...opts };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
        const state = url.searchParams.get('state') ?? '';
        const redirectUri = url.searchParams.get('redirect_uri') ?? '';
        const challenge = url.searchParams.get('code_challenge') ?? '';
        pending.set(state, { codeChallenge: challenge, redirectUri });
        // Return a tiny HTML page; tests drive completeLogin instead.
        send(res, 200, { status: 'consent_required', state });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/oauth/token') {
        if (options.failUpstream) {
          send(res, 503, { error: 'unavailable' });
          return;
        }
        const raw = await readBody(req);
        const params = new URLSearchParams(raw);
        if (params.get('grant_type') === 'client_credentials') {
          const access = `access_cc_${randomBytes(16).toString('hex')}`;
          tokens.set(access, { access });
          send(res, 200, {
            access_token: access,
            token_type: 'Bearer',
            expires_in: 3600,
          });
          return;
        }
        const code = params.get('code') ?? '';
        const verifier = params.get('code_verifier') ?? '';
        const entry = codes.get(code);
        if (!entry) {
          send(res, 400, { error: 'invalid_grant' });
          return;
        }
        // PKCE check (S256)
        const { createHash } = await import('node:crypto');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (challenge !== entry.verifierChallenge) {
          send(res, 400, { error: 'invalid_grant', error_description: 'pkce' });
          return;
        }
        codes.delete(code);
        const access = `access_${randomBytes(16).toString('hex')}`;
        tokens.set(access, { access });
        send(res, 200, {
          access_token: access,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: `refresh_${randomBytes(8).toString('hex')}`,
          scope: 'wow.profile openid',
        });
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/oauth/userinfo' || url.pathname === '/userinfo')) {
        if (options.failUpstream) {
          send(res, 503, { error: 'unavailable' });
          return;
        }
        const auth = req.headers.authorization ?? '';
        if (!auth.startsWith('Bearer ') || !tokens.has(auth.slice(7))) {
          send(res, 401, { error: 'unauthorized' });
          return;
        }
        send(res, 200, { id: 424242, battletag: 'Crusader#1234' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/profile/user/wow') {
        if (options.failUpstream) {
          send(res, 503, { error: 'unavailable' });
          return;
        }
        const auth = req.headers.authorization ?? '';
        if (!auth.startsWith('Bearer ') || !tokens.has(auth.slice(7))) {
          send(res, 401, { error: 'unauthorized' });
          return;
        }
        const ns = url.searchParams.get('namespace') ?? '';
        if (ns.toLowerCase().includes('classic')) {
          send(res, 403, { error: 'classic_namespace_rejected' });
          return;
        }
        if (!ns.startsWith('profile-forever-')) {
          send(res, 403, { error: 'wrong_namespace' });
          return;
        }
        if (options.emptyRoster) {
          send(res, 404, { code: 404, type: 'BLZ-API-ENOENT' });
          return;
        }
        const region = ns.replace('profile-forever-', '');
        let forever = FIXTURE_CHARS.filter((c) => (c as { _game?: string })._game !== 'other');
        if (region === 'eu') {
          forever = [
            {
              id: 2001,
              name: 'Stormcaller',
              surname: 'Silvervein',
              realm: { name: 'Everlook', id: 2, slug: 'everlook' },
              playable_class: { name: 'Shaman', id: 7 },
              playable_race: { name: 'Troll', id: 8 },
              faction: { type: 'HORDE', name: 'Horde' },
              level: 60,
            },
          ];
        } else if (region !== 'us') {
          // kr/tw empty by default in mock unless fixtures added
          forever = [];
        }
        send(res, 200, { wow_accounts: [{ id: 1, characters: forever }] });
        return;
      }



      if (req.method === 'GET' && url.pathname.startsWith('/data/wow/item/') && !url.pathname.includes('/media/')) {
        if (options.failUpstream) {
          send(res, 503, { error: 'unavailable' });
          return;
        }
        const auth = req.headers.authorization ?? '';
        if (!auth.startsWith('Bearer ') || !tokens.has(auth.slice(7))) {
          send(res, 401, { error: 'unauthorized' });
          return;
        }
        const ns = url.searchParams.get('namespace') ?? '';
        if (ns.toLowerCase().includes('classic')) {
          send(res, 403, { error: 'classic_namespace_rejected' });
          return;
        }
        if (!ns.startsWith('static-forever-')) {
          send(res, 403, { error: 'wrong_namespace' });
          return;
        }
        const idStr = url.pathname.split('/').pop() ?? '';
        const itemId = Number(idStr);
        const item = FIXTURE_FOREVER_ITEMS.find((i) => i.id === itemId);
        if (!item) {
          send(res, 404, { code: 404 });
          return;
        }
        const { icon, ...body } = item;
        void icon;
        send(res, 200, body);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/data/wow/search/item') {
        if (options.failUpstream) {
          send(res, 503, { error: 'unavailable' });
          return;
        }
        const auth = req.headers.authorization ?? '';
        if (!auth.startsWith('Bearer ') || !tokens.has(auth.slice(7))) {
          send(res, 401, { error: 'unauthorized' });
          return;
        }
        const ns = url.searchParams.get('namespace') ?? '';
        if (ns.toLowerCase().includes('classic') || !ns.startsWith('static-forever-')) {
          send(res, 403, { error: 'wrong_namespace' });
          return;
        }
        const inv = (url.searchParams.get('inventory_type.type') ?? '').toUpperCase();
        const page = Number(url.searchParams.get('_page') ?? '1') || 1;
        const pageSize = Number(url.searchParams.get('_pageSize') ?? '100') || 100;
        let matched = FIXTURE_FOREVER_ITEMS;
        if (inv) {
          matched = matched.filter((i) => i.inventory_type.type === inv);
        }
        const start = (page - 1) * pageSize;
        const slice = matched.slice(start, start + pageSize);
        send(res, 200, {
          page,
          pageSize,
          pageCount: Math.max(1, Math.ceil(matched.length / pageSize)),
          results: slice.map((i) => ({
            data: {
              id: i.id,
              name: { en_US: i.name },
              inventory_type: i.inventory_type,
              quality: i.quality,
              level: i.level,
              required_level: i.required_level,
              item_class: i.item_class,
              item_subclass: i.item_subclass,
            },
          })),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/data/wow/media/item/')) {
        if (options.failUpstream) {
          send(res, 503, { error: 'unavailable' });
          return;
        }
        const auth = req.headers.authorization ?? '';
        if (!auth.startsWith('Bearer ') || !tokens.has(auth.slice(7))) {
          send(res, 401, { error: 'unauthorized' });
          return;
        }
        const ns = url.searchParams.get('namespace') ?? '';
        // Forever-only: reject any Classic namespace (or anything containing 'classic').
        if (ns.toLowerCase().includes('classic')) {
          send(res, 403, { error: 'classic_namespace_rejected' });
          return;
        }
        // Forever static namespace only (confirmed 2026-11-04).
        if (!ns.startsWith('static-forever-')) {
          send(res, 403, { error: 'wrong_namespace' });
          return;
        }
        const idStr = url.pathname.split('/').pop() ?? '';
        const itemId = Number(idStr);
        if (!Number.isInteger(itemId) || itemId < 1) {
          send(res, 404, { code: 404 });
          return;
        }
        // Test itemIds for icon_url sanitizer integration:
        // 12345 valid; 90001 http; 90002 wrong host; 90003 lookalike; 90004 malformed
        let value: string;
        if (itemId === 90001) {
          value = 'http://render.worldofwarcraft.com/us/icons/56/inv_bad.jpg';
        } else if (itemId === 90002) {
          value = 'https://evil.example/us/icons/56/inv_bad.jpg';
        } else if (itemId === 90003) {
          value = 'https://render.worldofwarcraft.com.evil.com/us/icons/56/inv_bad.jpg';
        } else if (itemId === 90004) {
          value = 'not a url';
        } else {
          const fixture = FIXTURE_FOREVER_ITEMS.find((i) => i.id === itemId);
          const name = fixture?.icon ?? (itemId === 12345 ? 'inv_helmet_03' : `inv_misc_${itemId}`);
          value = `https://render.worldofwarcraft.com/forever-us/icons/56/${name}.jpg`;
        }
        send(res, 200, {
          assets: [{ key: 'icon', value }],
        });
        return;
      }


      if (req.method === 'GET' && url.pathname === '/data/wow/item-set/index') {
        if (options.failUpstream) {
          send(res, 503, { error: 'unavailable' });
          return;
        }
        const auth = req.headers.authorization ?? '';
        if (!auth.startsWith('Bearer ') || !tokens.has(auth.slice(7))) {
          send(res, 401, { error: 'unauthorized' });
          return;
        }
        const ns = url.searchParams.get('namespace') ?? '';
        if (ns.toLowerCase().includes('classic') || !ns.startsWith('static-forever-')) {
          send(res, 403, { error: 'wrong_namespace' });
          return;
        }
        send(res, 200, {
          item_sets: FIXTURE_ITEM_SETS.map((s) => ({ id: s.id, name: s.name })),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/data/wow/item-set/')) {
        if (options.failUpstream) {
          send(res, 503, { error: 'unavailable' });
          return;
        }
        const auth = req.headers.authorization ?? '';
        if (!auth.startsWith('Bearer ') || !tokens.has(auth.slice(7))) {
          send(res, 401, { error: 'unauthorized' });
          return;
        }
        const ns = url.searchParams.get('namespace') ?? '';
        if (ns.toLowerCase().includes('classic') || !ns.startsWith('static-forever-')) {
          send(res, 403, { error: 'wrong_namespace' });
          return;
        }
        const idStr = url.pathname.split('/').pop() ?? '';
        if (idStr === 'index') {
          send(res, 404, { error: 'not_found' });
          return;
        }
        const setId = Number(idStr);
        const set = FIXTURE_ITEM_SETS.find((s) => s.id === setId);
        if (!set) {
          send(res, 404, { code: 404 });
          return;
        }
        send(res, 200, set);
        return;
      }

      send(res, 404, { error: 'not_found', path: url.pathname });
    } catch (err) {
      send(res, 500, { error: 'internal', message: String(err) });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('mock blizzard failed to bind');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const config: BlizzardClientConfig = {
    clientId: 'mock-client-id',
    clientSecret: 'mock-client-secret',
    region: 'us',
    regions: ['us', 'eu'],
    authorizeUrl: `${baseUrl}/oauth/authorize`,
    tokenUrl: `${baseUrl}/oauth/token`,
    apiBaseUrl: baseUrl,
    redirectUri: 'http://127.0.0.1/api/v1/auth/blizzard/callback',
  };
  const client = createBlizzardClient(config);

  const mock: MockBlizzard = {
    server,
    baseUrl,
    authorizeUrl: config.authorizeUrl,
    tokenUrl: config.tokenUrl,
    apiBaseUrl: config.apiBaseUrl ?? baseUrl,
    client,
    config,
    options,
    completeLogin({ authorizeUrl, outcome }) {
      const u = new URL(authorizeUrl);
      const state = u.searchParams.get('state') ?? '';
      const redirectUri = u.searchParams.get('redirect_uri') ?? '';
      const challenge = u.searchParams.get('code_challenge') ?? '';
      const dest = new URL(redirectUri);
      if (outcome === 'access_denied') {
        dest.searchParams.set('error', 'access_denied');
        dest.searchParams.set('state', state);
        return { redirectTo: dest.toString() };
      }
      const code = `code_${randomBytes(12).toString('hex')}`;
      codes.set(code, { verifierChallenge: challenge, redirectUri });
      pending.delete(state);
      dest.searchParams.set('code', code);
      dest.searchParams.set('state', state);
      return { redirectTo: dest.toString() };
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
  return mock;
}
