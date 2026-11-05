import type { FastifyInstance } from 'fastify';
import type { Pool } from '../db/pool.js';
import type { Config } from '../config.js';
import type { BlizzardClient } from '../blizzard/client.js';
import { decryptSecret, TokenDecryptError } from '../lib/crypto.js';
import { sanitizeBlizzardIconUrl } from '../lib/icon-url.js';
import { AppError } from '../lib/errors.js';
import * as store from '../auth/store.js';
import { requireCsrf, requireSession } from '../auth/session.js';

const SLOTS = new Set([
  'head', 'neck', 'shoulder', 'back', 'chest', 'shirt', 'tabard', 'wrist', 'hands',
  'waist', 'legs', 'feet', 'finger1', 'finger2', 'trinket1', 'trinket2',
  'main_hand', 'off_hand', 'ranged',
]);
const QUALITIES = new Set(['poor', 'common', 'uncommon', 'rare', 'epic', 'legendary', null]);

export type GearDeps = {
  pool: Pool;
  config: Config;
  blizzard: BlizzardClient;
};

type EquippedItemIn = {
  slot?: string;
  itemId?: number;
  name?: string | null;
  quality?: string | null;
  ilvl?: number | null;
  icon?: string | null;
  icon_url?: string | null;
};

type EquippedItemOut = {
  slot: string;
  itemId: number;
  name: string | null;
  quality: string | null;
  ilvl: number | null;
  icon: string | null;
  icon_url: string | null;
};

function validateItems(items: unknown): EquippedItemIn[] {
  if (!Array.isArray(items)) {
    throw new AppError(400, 'validation_error', 'Invalid gear.', { items: 'Must be an array.' });
  }
  if (items.length > 19) {
    throw new AppError(400, 'validation_error', 'Invalid gear.', { items: 'Too many items.' });
  }
  const seen = new Set<string>();
  const out: EquippedItemIn[] = [];
  for (const raw of items) {
    const it = raw as EquippedItemIn;
    if (!it || typeof it.slot !== 'string' || !SLOTS.has(it.slot)) {
      throw new AppError(400, 'validation_error', 'Invalid gear.', { slot: 'Unknown or missing slot.' });
    }
    if (seen.has(it.slot)) {
      throw new AppError(400, 'validation_error', 'Invalid gear.', { slot: 'Duplicate slot.' });
    }
    seen.add(it.slot);
    if (typeof it.itemId !== 'number' || !Number.isInteger(it.itemId) || it.itemId < 1) {
      throw new AppError(400, 'validation_error', 'Invalid gear.', { itemId: 'Must be a positive integer.' });
    }
    if (it.quality !== undefined && !QUALITIES.has(it.quality)) {
      throw new AppError(400, 'validation_error', 'Invalid gear.', { quality: 'Invalid quality.' });
    }
    out.push({
      slot: it.slot,
      itemId: it.itemId,
      name: it.name ?? null,
      quality: it.quality ?? null,
      ilvl: it.ilvl ?? null,
      icon: it.icon ?? null,
      // Client-supplied icon_url is ignored; platform resolves from Forever Item Media (static-forever-{region}).
    });
  }
  return out;
}

async function resolveIconUrl(
  pool: Pool,
  blizzard: BlizzardClient,
  accessToken: string | null,
  itemId: number,
  region: string,
): Promise<{ icon_url: string | null; icon_name: string | null }> {
  const cached = await store.getCachedItemIcon(pool, itemId, region);
  if (cached) return cached;
  if (!accessToken) return { icon_url: null, icon_name: null };
  try {
    const media = await blizzard.fetchItemIconUrl(accessToken, itemId, region as 'us');
    const iconUrl = sanitizeBlizzardIconUrl(media.iconUrl);
    const iconName = iconUrl ? media.iconName : null;
    // Cache only sanitized values (null = looked up, nothing valid to serve).
    await store.upsertCachedItemIcon(pool, {
      itemId,
      region,
      iconUrl,
      iconName,
    });
    return { icon_url: iconUrl, icon_name: iconName };
  } catch {
    return { icon_url: null, icon_name: null };
  }
}

async function enrichItems(
  pool: Pool,
  config: Config,
  blizzard: BlizzardClient,
  user: store.UserRow | null,
  items: EquippedItemIn[],
  region: string,
): Promise<EquippedItemOut[]> {
  let access: string | null = null;
  if (user?.access_token) {
    try {
      access = decryptSecret(user.access_token, config.TOKEN_ENC_KEY, {
        previousKeyHex: config.TOKEN_ENC_KEY_PREVIOUS,
      });
    } catch {
      access = null;
    }
  }
  const out: EquippedItemOut[] = [];
  for (const it of items) {
    const icon = await resolveIconUrl(pool, blizzard, access, it.itemId!, region);
    out.push({
      slot: it.slot!,
      itemId: it.itemId!,
      name: it.name ?? null,
      quality: it.quality ?? null,
      ilvl: typeof it.ilvl === 'number' ? it.ilvl : null,
      icon: it.icon ?? icon.icon_name ?? null,
      icon_url: icon.icon_url,
    });
  }
  return out;
}

export async function registerGearRoutes(app: FastifyInstance, deps: GearDeps): Promise<void> {
  const { pool, config, blizzard } = deps;

  app.get<{ Params: { character_id: string } }>(
    '/api/v1/characters/:character_id/gear',
    async (req) => {
      const s = requireSession(req);
      const characterId = req.params.character_id;
      const owned = await store.getCharacterForUser(pool, s.userId, characterId);
      if (!owned) {
        throw new AppError(404, 'not_found', 'Character not found.');
      }
      const gear = await store.getCharacterGear(pool, characterId);
      return {
        character_id: characterId,
        updated_at:
          gear && gear.updated_at.getTime() > 0
            ? gear.updated_at.toISOString()
            : new Date(0).toISOString(),
        items: gear?.items ?? [],
      };
    },
  );

  app.put<{ Params: { character_id: string } }>(
    '/api/v1/characters/:character_id/gear',
    async (req) => {
      requireCsrf(req);
      const s = requireSession(req);
      const characterId = req.params.character_id;
      const owned = await store.getCharacterForUser(pool, s.userId, characterId);
      if (!owned) {
        throw new AppError(404, 'not_found', 'Character not found.');
      }
      const body = req.body as { items?: unknown };
      const items = validateItems(body?.items);
      const user = await store.getUser(pool, s.userId);
      const enriched = await enrichItems(
        pool,
        config,
        blizzard,
        user,
        items,
        owned.region,
      );
      const saved = await store.putCharacterGear(pool, characterId, enriched);
      return {
        character_id: saved.character_id,
        updated_at: saved.updated_at.toISOString(),
        items: saved.items,
      };
    },
  );
}
