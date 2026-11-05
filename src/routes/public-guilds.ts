import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { isForeverRealmSlug, isValidSlug } from '../guilds/realms.js';
import { checkPublicRateLimit, clearPublicRateLimits, type PublicRateBucket } from '../guilds/rate-limit.js';
import * as guilds from '../guilds/store.js';

export type PublicGuildDeps = { pool: Pool };

const CACHE_CONTROL = 'public, max-age=300';

function clientIp(req: FastifyRequest): string {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length > 0) return xf.split(',')[0]!.trim();
  if (Array.isArray(xf) && xf[0]) return xf[0].split(',')[0]!.trim();
  return req.ip || 'unknown';
}

function setRateHeaders(reply: FastifyReply, rate: Awaited<ReturnType<typeof checkPublicRateLimit>>): void {
  reply.header('RateLimit-Limit', String(rate.limit));
  reply.header('RateLimit-Remaining', String(rate.remaining));
  reply.header('RateLimit-Reset', String(rate.resetSec));
}

async function enforceRate(
  pool: Pool,
  req: FastifyRequest,
  reply: FastifyReply,
  bucket: PublicRateBucket,
): Promise<void> {
  const rate = await checkPublicRateLimit(pool, clientIp(req), bucket);
  setRateHeaders(reply, rate);
  if (!rate.allowed) {
    reply.header('Retry-After', String(rate.retryAfterSec));
    throw new AppError(429, 'rate_limited', 'Too many requests. Try again shortly.');
  }
}

function parseLimit(raw: unknown, def: number, max: number): number {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new AppError(400, 'validation_error', 'Invalid limit.', { limit: `Must be an integer 1..${max}.` });
  }
  return n;
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

export async function registerPublicGuildRoutes(
  app: FastifyInstance,
  deps: PublicGuildDeps,
): Promise<void> {
  const { pool } = deps;

  // Sitemap MUST be registered before /:realm_slug/:guild_slug
  app.get('/api/v1/public/guilds/sitemap', async (req, reply) => {
    await enforceRate(pool, req, reply, 'sitemap');
    const q = req.query as Record<string, unknown>;
    const limit = parseLimit(q.limit, 200, 500);
    const cursor = typeof q.cursor === 'string' && q.cursor.length > 0 ? q.cursor : undefined;
    let page;
    try {
      page = await guilds.listPublicSitemap(pool, { cursor, limit });
    } catch (err) {
      if (err instanceof Error && err.message === 'bad_cursor') {
        throw new AppError(400, 'validation_error', 'Invalid cursor.', { cursor: 'Invalid cursor.' });
      }
      throw err;
    }
    const body = {
      items: page.items.map((i) => ({
        realm_slug: i.realm_slug,
        guild_slug: i.guild_slug,
        updated_at: i.updated_at.toISOString(),
      })),
      next_cursor: page.next_cursor,
    };
    const contentEtag = guilds.etagForGuild({
      id: 'sitemap',
      version: page.items.length,
      updated_at: page.items[0]?.updated_at ?? new Date(0),
    });
    if (maybe304(req, reply, contentEtag)) return;
    cacheHeaders(reply, contentEtag);
    return body;
  });

  app.get('/api/v1/public/guilds', async (req, reply) => {
    await enforceRate(pool, req, reply, 'list_detail');
    const q = req.query as Record<string, unknown>;
    const limit = parseLimit(q.limit, 25, 50);
    const cursor = typeof q.cursor === 'string' && q.cursor.length > 0 ? q.cursor : undefined;

    let realm: string | undefined;
    if (typeof q.realm === 'string' && q.realm.length > 0) {
      if (!isValidSlug(q.realm) || !isForeverRealmSlug(q.realm)) {
        throw new AppError(400, 'validation_error', 'Unknown or invalid realm.', {
          realm: 'Must be a known Forever realm slug.',
        });
      }
      realm = q.realm.toLowerCase();
    }

    let faction: 'alliance' | 'horde' | undefined;
    if (typeof q.faction === 'string' && q.faction.length > 0) {
      if (q.faction !== 'alliance' && q.faction !== 'horde') {
        throw new AppError(400, 'validation_error', 'Invalid faction.', {
          faction: 'Must be alliance or horde.',
        });
      }
      faction = q.faction;
    }

    let role: 'tank' | 'healer' | 'dps' | undefined;
    if (typeof q.role === 'string' && q.role.length > 0) {
      if (q.role !== 'tank' && q.role !== 'healer' && q.role !== 'dps') {
        throw new AppError(400, 'validation_error', 'Invalid role.', {
          role: 'Must be tank, healer, or dps.',
        });
      }
      role = q.role;
    }

    let klass: string | undefined;
    if (typeof q.class === 'string' && q.class.length > 0) {
      if (!guilds.isForeverClass(q.class)) {
        throw new AppError(400, 'validation_error', 'Invalid class.', {
          class: 'Must be a Forever class token (lowercase).',
        });
      }
      klass = q.class.toLowerCase();
    }

    let page;
    try {
      page = await guilds.listPublicGuilds(pool, {
        realm,
        faction,
        role,
        class: klass,
        cursor,
        limit,
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'bad_cursor') {
        throw new AppError(400, 'validation_error', 'Invalid cursor.', { cursor: 'Invalid cursor.' });
      }
      throw err;
    }

    const body = {
      items: page.items.map(guilds.toSummary),
      next_cursor: page.next_cursor,
    };
    const contentEtag = guilds.etagForGuild({
      id: 'list',
      version: page.items.length,
      updated_at: page.items[0]?.updated_at ?? new Date(0),
    });
    if (maybe304(req, reply, contentEtag)) return;
    cacheHeaders(reply, contentEtag);
    return body;
  });

  app.get<{ Params: { realm_slug: string; guild_slug: string } }>(
    '/api/v1/public/guilds/:realm_slug/:guild_slug',
    async (req, reply) => {
      await enforceRate(pool, req, reply, 'list_detail');
      const { realm_slug, guild_slug } = req.params;
      if (!isValidSlug(realm_slug) || !isValidSlug(guild_slug)) {
        throw new AppError(404, 'not_found', 'Guild not found.');
      }
      const row = await guilds.getPublicGuild(pool, realm_slug.toLowerCase(), guild_slug.toLowerCase());
      if (!row) {
        throw new AppError(404, 'not_found', 'Guild not found.');
      }
      const etag = guilds.etagForGuild(row);
      if (maybe304(req, reply, etag)) return;
      cacheHeaders(reply, etag);
      return guilds.toDetail(row);
    },
  );

  // Test helper — clear anonymous rate limits between cases
  if (process.env.NODE_ENV === 'test') {
    app.post('/api/v1/public/_test/clear-rate-limits', async () => {
      await clearPublicRateLimits(pool);
      return { ok: true };
    });
  }
}
