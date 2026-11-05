import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { GEAR_SLOTS, type GearSlot } from '../gear/schema.js';
import { isArmorType, isGearSlot } from '../items/mapping.js';
import * as items from '../items/store.js';
import { checkPublicRateLimit } from '../guilds/rate-limit.js';

export type ItemsRouteDeps = { pool: Pool };

const CACHE_CONTROL = 'public, max-age=300';

function setRateHeaders(
  reply: FastifyReply,
  rate: Awaited<ReturnType<typeof checkPublicRateLimit>>,
): void {
  reply.header('RateLimit-Limit', String(rate.limit));
  reply.header('RateLimit-Remaining', String(rate.remaining));
  reply.header('RateLimit-Reset', String(rate.resetSec));
}

async function enforceItemsRate(
  pool: Pool,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const rate = await checkPublicRateLimit(pool, req.ip || 'unknown', 'items');
  setRateHeaders(reply, rate);
  if (!rate.allowed) {
    reply.header('Retry-After', String(rate.retryAfterSec));
    throw new AppError(429, 'rate_limited', 'Too many requests. Try again shortly.', undefined, {
      retryAfterSec: rate.retryAfterSec,
    });
  }
}

function maybe304(req: FastifyRequest, reply: FastifyReply, etag: string): boolean {
  const inm = req.headers['if-none-match'];
  if (!inm) return false;
  const values = (Array.isArray(inm) ? inm.join(',') : inm).split(',').map((s) => s.trim());
  if (values.includes(etag) || values.includes('*')) {
    reply.header('ETag', etag);
    reply.header('Cache-Control', CACHE_CONTROL);
    reply.header('Vary', 'Accept-Encoding');
    reply.code(304).send();
    return true;
  }
  return false;
}

function cacheHeaders(reply: FastifyReply, etag: string): void {
  reply.header('ETag', etag);
  reply.header('Cache-Control', CACHE_CONTROL);
  reply.header('Vary', 'Accept-Encoding');
}

function parseOptionalInt(
  raw: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new AppError(400, 'validation_error', `Invalid ${field}.`, {
      [field]: `Must be an integer ${min}..${max}.`,
    });
  }
  return n;
}

function parseSlot(raw: unknown): GearSlot | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const v = String(raw);
  if (!isGearSlot(v)) {
    throw new AppError(400, 'validation_error', 'Invalid slot.', {
      slot: 'invalid_slot',
    });
  }
  return v;
}

/** `class` (Web) or `armor_type` → cloth|leather|mail|plate. */
function parseArmorClass(q: Record<string, unknown>): string | undefined {
  const raw = q.class ?? q.armor_type;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const v = String(raw).toLowerCase();
  if (!isArmorType(v)) {
    throw new AppError(400, 'validation_error', 'Invalid class.', {
      class: 'Must be cloth, leather, mail, or plate.',
    });
  }
  return v;
}

export async function registerItemsRoutes(
  app: FastifyInstance,
  deps: ItemsRouteDeps,
): Promise<void> {
  const { pool } = deps;

  const listHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    await enforceItemsRate(pool, req, reply);
    const q = req.query as Record<string, unknown>;
    const slot = parseSlot(q.slot);
    const armorType = parseArmorClass(q);
    const minItemLevel = parseOptionalInt(q.min_item_level ?? q.min_ilvl, 'min_item_level', 0, 1000);
    const maxRequiredLevel = parseOptionalInt(
      q.max_required_level ?? q.max_req_level,
      'max_required_level',
      0,
      60,
    );
    let qText: string | undefined;
    if (q.q !== undefined && q.q !== null && q.q !== '') {
      qText = String(q.q).trim();
      if (qText.length < 1 || qText.length > 64) {
        throw new AppError(400, 'validation_error', 'Invalid q.', {
          q: 'Must be 1..64 characters.',
        });
      }
    }
    const cursor = typeof q.cursor === 'string' && q.cursor.length > 0 ? q.cursor : undefined;
    const limit = parseOptionalInt(q.limit, 'limit', 1, 100) ?? 50;

    let page;
    try {
      page = await items.listItems(pool, {
        slot,
        armorType,
        q: qText,
        minItemLevel,
        maxRequiredLevel,
        cursor,
        limit,
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'bad_cursor') {
        throw new AppError(400, 'validation_error', 'Invalid cursor.', {
          cursor: 'Invalid cursor.',
        });
      }
      throw err;
    }

    const body = {
      items: page.items.map(items.toWire),
      next_cursor: page.next_cursor,
    };
    const meta = await items.getMeta(pool);
    const etag = items.etagForItems(meta.build_id, 'list', body);
    if (maybe304(req, reply, etag)) return;
    cacheHeaders(reply, etag);
    return body;
  };

  app.get('/api/v1/items', listHandler);
  // Alias for the reserved search path from platform#17.
  app.get('/api/v1/items/search', listHandler);

  app.get('/api/v1/items/:item_id', async (req, reply) => {
    await enforceItemsRate(pool, req, reply);
    const params = req.params as { item_id: string };
    const itemId = Number(params.item_id);
    if (!Number.isInteger(itemId) || itemId < 1) {
      throw new AppError(400, 'validation_error', 'Invalid item_id.', {
        item_id: 'Must be a positive integer.',
      });
    }
    const row = await items.getItem(pool, itemId);
    if (!row) {
      throw new AppError(404, 'not_found', 'Item not found.');
    }
    const body = items.toWire(row);
    const meta = await items.getMeta(pool);
    const etag = items.etagForItems(meta.build_id, 'item', body);
    if (maybe304(req, reply, etag)) return;
    cacheHeaders(reply, etag);
    return body;
  });
}
