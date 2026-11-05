import EmbeddedPostgres from 'embedded-postgres';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { createPool, type Pool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { loadConfig, type Config } from '../../src/config.js';
import { buildApp } from '../../src/app.js';
import { startMockBlizzard, type MockBlizzard } from '../../src/blizzard/mock.js';
import { createBlizzardClient } from '../../src/blizzard/client.js';
import type { FastifyInstance } from 'fastify';

export type TestCtx = {
  app: FastifyInstance;
  pool: Pool;
  mock: MockBlizzard;
  config: Config;
  databaseUrl: string;
  stop: () => Promise<void>;
};

let pg: EmbeddedPostgres | null = null;
let dataDir: string | null = null;
let databaseUrl: string | null = null;

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('failed to bind ephemeral port'));
        return;
      }
      const { port } = addr;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function ensurePg(): Promise<string> {
  if (databaseUrl) return databaseUrl;
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'cs-pg-'));
  const port = await getFreePort();
  pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: true,
    autoRehydrateSymlinks: true,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('crusaderstrike');
  databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/crusaderstrike`;
  await migrate(databaseUrl);
  return databaseUrl;
}

export async function startTestApp(opts?: {
  failUpstream?: boolean;
  emptyRoster?: boolean;
}): Promise<TestCtx> {
  const url = await ensurePg();
  const pool = createPool(url);
  await pool.query(`
    TRUNCATE character_gear, character_selections, characters, sessions, oauth_states, users CASCADE
  `);

  const mock = await startMockBlizzard({
    failUpstream: opts?.failUpstream,
    emptyRoster: opts?.emptyRoster,
  });

  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: '3456',
    DATABASE_URL: url,
    SESSION_SECRET: 'test-session-secret-at-least-32-chars!!',
    BLIZZARD_MOCK: 'true',
    PUBLIC_WEB_ORIGIN: 'https://crusaderstrike.com',
    PUBLIC_API_ORIGIN: 'http://127.0.0.1',
    BLIZZARD_REDIRECT_URI: 'http://127.0.0.1/api/v1/auth/blizzard/callback',
    CORS_ORIGINS: 'https://crusaderstrike.com,https://www.crusaderstrike.com',
    COOKIE_SECURE: 'false',
  });

  const blizzard = createBlizzardClient({
    ...mock.config,
    redirectUri: config.BLIZZARD_REDIRECT_URI,
  });

  const app = await buildApp({
    config,
    pool,
    blizzard,
    redirectUri: config.BLIZZARD_REDIRECT_URI,
  });
  await app.ready();
  app.clearRefreshCooldowns?.();

  return {
    app,
    pool,
    mock,
    config,
    databaseUrl: url,
    stop: async () => {
      await app.close();
      await mock.close();
      await pool.end();
    },
  };
}

export async function shutdownEmbeddedPg(): Promise<void> {
  if (pg) {
    await pg.stop();
    pg = null;
  }
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = null;
  }
  databaseUrl = null;
}

export async function signIn(
  ctx: TestCtx,
  opts?: { returnTo?: string; outcome?: 'ok' | 'access_denied' },
): Promise<{ cookie: string; csrf: string; location: string }> {
  const returnTo = opts?.returnTo ?? '/signin.html';
  const login = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/auth/blizzard/login?return_to=${encodeURIComponent(returnTo)}`,
  });
  if (login.statusCode !== 302 || !login.headers.location) {
    throw new Error(`login failed: ${login.statusCode} ${login.body}`);
  }
  const authorizeUrl = login.headers.location as string;
  const { redirectTo } = ctx.mock.completeLogin({
    authorizeUrl,
    outcome: opts?.outcome ?? 'ok',
  });
  const cbUrl = new URL(redirectTo);
  const callback = await ctx.app.inject({
    method: 'GET',
    url: cbUrl.pathname + cbUrl.search,
  });
  const setCookie = callback.headers['set-cookie'];
  const cookieRaw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const cookie = cookieRaw?.split(';')[0] ?? '';
  const location = String(callback.headers.location ?? '');
  if (opts?.outcome === 'access_denied') {
    return { cookie, csrf: '', location };
  }
  const session = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/auth/session',
    headers: { cookie },
  });
  if (session.statusCode !== 200) {
    throw new Error(`session after login failed: ${session.statusCode} ${session.body} loc=${location}`);
  }
  const body = session.json() as { csrf_token: string };
  return { cookie, csrf: body.csrf_token, location };
}
