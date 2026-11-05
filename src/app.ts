import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import type { Pool } from './db/pool.js';
import type { Config } from './config.js';
import type { BlizzardClient } from './blizzard/client.js';
import { AppError, requestId } from './lib/errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerProfileRoutes } from './routes/profile.js';
import { registerGearRoutes } from './routes/gear.js';
import { registerUploadRoutes } from './routes/uploads.js';
import { registerGearListRoutes } from './routes/gear-lists.js';
import { registerPublicGuildRoutes } from './routes/public-guilds.js';

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

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.fields) {
        return reply.code(err.statusCode).send({ errors: err.fields });
      }
      return reply.code(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          request_id: req.id,
        },
      });
    }
    if ((err as { validation?: unknown }).validation) {
      return reply.code(400).send({
        errors: { body: 'Invalid request.' },
      });
    }
    if ((err as { statusCode?: number }).statusCode === 415) {
      return reply.code(415).send({
        error: { code: 'unsupported_media_type', message: 'Content-Type must be application/json.', request_id: req.id },
      });
    }
    if ((err as { statusCode?: number; code?: string }).statusCode === 413 ||
        (err as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({
        error: { code: 'payload_too_large', message: 'Body exceeds size limit.', request_id: req.id },
      });
    }
    req.log.error(err);
    return reply.code(500).send({
      error: { code: 'internal_error', message: 'Something went wrong.', request_id: req.id },
    });
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/api/v1/healthz', async () => ({ ok: true }));

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

  return app;
}
