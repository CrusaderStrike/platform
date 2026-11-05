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
