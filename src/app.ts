import Fastify, { type FastifyInstance } from 'fastify';
import { clearSessionCookie } from './auth/session.js';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import type { Pool } from './db/pool.js';
import type { Config } from './config.js';
import type { BlizzardClient } from './blizzard/client.js';
import { AppError, publicErrorBody, requestId, ERROR_CATALOG } from './lib/errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerProfileRoutes } from './routes/profile.js';
import { registerGearRoutes } from './routes/gear.js';
import { registerUploadRoutes } from './routes/uploads.js';
import { registerGearListRoutes } from './routes/gear-lists.js';
import { registerPublicGuildRoutes } from './routes/public-guilds.js';
import { registerItemsRoutes } from './routes/items.js';

export type BuildAppOptions = {
  config: Config;
  pool: Pool;
  blizzard: BlizzardClient;
  redirectUri?: string;
};

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.config.NODE_ENV !== 'test',
    genReqId: () => requestId(),
    // Only honor X-Forwarded-* from TRUSTED_PROXY (Caddy on the docker network by default).
    trustProxy: opts.config.trustProxy,
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      cb(null, opts.config.corsOrigins.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'If-Match', 'If-None-Match', 'Authorization'],
    // So credentialed browser JS can read the 429 countdown on refresh.
    exposedHeaders: ['Retry-After', 'ETag', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
  });
  await app.register(cookie);

  registerErrorHandler(app, { cookieSecure: opts.config.cookieSecure });

  // Deploy identity only — never attach env, version strings, or other build metadata.
  const healthz = () => ({ ok: true as const, sha: opts.config.BUILD_SHA });
  app.get('/healthz', async () => healthz());
  app.get('/api/v1/healthz', async () => healthz());

  const redirectUri = opts.redirectUri ?? opts.config.BLIZZARD_REDIRECT_URI;

  await registerAuthRoutes(app, {
    pool: opts.pool,
    config: opts.config,
    blizzard: opts.blizzard,
    redirectUri,
  });
  await registerProfileRoutes(app, { pool: opts.pool, config: opts.config, blizzard: opts.blizzard });
  await registerGearRoutes(app, { pool: opts.pool, config: opts.config, blizzard: opts.blizzard });
  await registerUploadRoutes(app, { pool: opts.pool });
  await registerGearListRoutes(app, { pool: opts.pool });
  await registerPublicGuildRoutes(app, { pool: opts.pool });
  await registerItemsRoutes(app, { pool: opts.pool });

  return app;
}

/** Central error handler (exported so tests can mount it on a bare instance). */
export function registerErrorHandler(app: FastifyInstance, opts: { cookieSecure: boolean }): void {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.code === 'session_expired') {
        // Dead/malformed cookie: tell the browser to drop it (platform#53).
        clearSessionCookie(reply, opts.cookieSecure);
      }
      if (err.retryAfterSec !== undefined && err.retryAfterSec >= 0) {
        reply.header('Retry-After', String(err.retryAfterSec));
      }
      // Field maps stay as `{ errors }` for Web/Addon compatibility (platform#51).
      if (err.fields) {
        return reply.code(err.statusCode).send({ errors: err.fields });
      }
      return reply
        .code(err.statusCode)
        .send(publicErrorBody(err.code, err.message, String(req.id), err.retryable, err.details));
    }
    if ((err as { validation?: unknown }).validation) {
      return reply.code(400).send({
        errors: { body: 'Invalid request.' },
      });
    }
    // Malformed / empty JSON body → 400 validation_error using the #51 field-map shape.
    const fstCode = (err as { code?: string }).code;
    if (
      fstCode === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
      fstCode === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
      (err instanceof SyntaxError && (err as { statusCode?: number }).statusCode === 400)
    ) {
      // platform#55: `invalid_json` is a field-error value (not an error.code). The additive
      // human-readable `message` lets clients show text without changing the `errors` map.
      return reply
        .code(400)
        .send({ errors: { body: 'invalid_json' }, message: 'Request body is not valid JSON.' });
    }
    if ((err as { statusCode?: number }).statusCode === 415) {
      return reply
        .code(415)
        .send(
          publicErrorBody(
            'unsupported_media_type',
            'Content-Type must be application/json.',
            String(req.id),
            ERROR_CATALOG.unsupported_media_type.retryable,
          ),
        );
    }
    if ((err as { statusCode?: number; code?: string }).statusCode === 413 ||
        (err as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply
        .code(413)
        .send(
          publicErrorBody(
            'payload_too_large',
            'Body exceeds size limit.',
            String(req.id),
            ERROR_CATALOG.payload_too_large.retryable,
          ),
        );
    }
    // Never forward stacks, upstream bodies, or secrets to clients.
    req.log.error(err);
    return reply
      .code(500)
      .send(
        publicErrorBody(
          'internal_error',
          'Something went wrong.',
          String(req.id),
          ERROR_CATALOG.internal_error.retryable,
        ),
      );
  });

}
