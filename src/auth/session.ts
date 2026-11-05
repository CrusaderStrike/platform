import type { FastifyReply, FastifyRequest } from 'fastify';
import { safeEqual } from '../lib/crypto.js';
import { AppError, isUuid } from '../lib/errors.js';
import type { Pool } from '../db/pool.js';
import * as store from './store.js';

export const SESSION_COOKIE = 'cs_session';

export type RequestSession = {
  sessionId: string;
  userId: string;
  battletag: string;
  csrfToken: string;
  preferredRegion: 'us' | 'eu' | 'kr' | 'tw';
  activeGuildId: string | null;
};

declare module 'fastify' {
  interface FastifyRequest {
    csSession?: RequestSession;
  }
}

export async function loadSession(pool: Pool, req: FastifyRequest): Promise<RequestSession | null> {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (!sid) return null;
  // Malformed cookie (not a UUID) can never match a session; skip the query so
  // Postgres doesn't raise 22P02 → 500. requireSession then emits session_expired.
  if (!isUuid(sid)) return null;
  const row = await store.getSession(pool, sid);
  if (!row) return null;
  return {
    sessionId: row.id,
    userId: row.user_id,
    battletag: row.battletag,
    csrfToken: row.csrf_token,
    preferredRegion: row.preferred_region,
    activeGuildId: row.active_guild_id,
  };
}

/**
 * Require a loaded session.
 * - No cookie → `unauthenticated`
 * - Cookie present but session missing/expired/revoked → `session_expired`
 */
export function requireSession(req: FastifyRequest): RequestSession {
  if (!req.csSession) {
    const sid = req.cookies?.[SESSION_COOKIE];
    if (sid) {
      throw new AppError(401, 'session_expired', 'Session expired. Sign in again.');
    }
    throw new AppError(401, 'unauthenticated', 'Sign in required.');
  }
  return req.csSession;
}

export function requireCsrf(req: FastifyRequest): void {
  const session = requireSession(req);
  const header = req.headers['x-csrf-token'];
  const token = Array.isArray(header) ? header[0] : header;
  if (!token || !safeEqual(token, session.csrfToken)) {
    throw new AppError(403, 'csrf_failed', 'Security check failed. Reload and try again.');
  }
}

export function setSessionCookie(
  reply: FastifyReply,
  sessionId: string,
  opts: { secure: boolean; maxAgeSec?: number },
): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    path: '/',
    httpOnly: true,
    secure: opts.secure,
    sameSite: 'lax',
    maxAge: opts.maxAgeSec ?? 30 * 24 * 60 * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'lax',
  });
}
