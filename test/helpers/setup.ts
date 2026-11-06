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

export const TEST_TOKEN_ENC_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/** Valid non-placeholder key for production config tests. */
export const PROD_SAFE_TOKEN_ENC_KEY =
  'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00';

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
  // Prod sets BYPASSRLS via initdb/01-roles.sh. Migration 012 requires it (no ALTER ROLE
  // in-migration). Pre-create / align roles so the SECURITY DEFINER sweeper check passes.
  {
    const boot = createPool(databaseUrl);
    try {
      await boot.query(`
        DO $do$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crusaderstrike_migrate') THEN
            CREATE ROLE crusaderstrike_migrate NOLOGIN BYPASSRLS;
          ELSE
            ALTER ROLE crusaderstrike_migrate WITH BYPASSRLS;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crusaderstrike_app') THEN
            CREATE ROLE crusaderstrike_app NOLOGIN NOBYPASSRLS;
          END IF;
        END
        $do$;
      `);
    } finally {
      await boot.end();
    }
  }
  await migrate(databaseUrl);
  return databaseUrl;
}

export async function startTestApp(opts?: {
  failUpstream?: boolean;
  emptyRoster?: boolean;
  regions?: string;
  /** Optional BUILD_SHA for /healthz tests (platform#49). */
  buildSha?: string;
  /**
   * Force COOKIE_SECURE. Default false (plain-http harness).
   * Pass true to exercise the production Secure cookie path (platform#60).
   */
  cookieSecure?: boolean;
}): Promise<TestCtx> {
  const url = await ensurePg();
  const pool = createPool(url);
  await pool.query(`
    TRUNCATE public_api_rate_limits, upload_rate_limits, gear_write_rate_limits, pvp_battlegrounds, pvp_world_events, dungeon_runs,
             gear_op_noop_ids, gear_list_events, gear_list_items, gear_lists, guild_members, guilds,
             forever_item_set_items, forever_item_sets, forever_items, forever_items_meta, item_icon_cache, character_gear, character_selections, characters, sessions, oauth_states, users CASCADE
  `);
  await pool.query(`INSERT INTO forever_items_meta (id, build_id, item_count) VALUES (1, 'empty', 0) ON CONFLICT (id) DO NOTHING`);

  const mock = await startMockBlizzard({
    failUpstream: opts?.failUpstream,
    emptyRoster: opts?.emptyRoster,
  });

  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: '3456',
    DATABASE_URL: url,
    SESSION_SECRET: 'test-session-secret-at-least-32-chars!!',
    TOKEN_ENC_KEY: TEST_TOKEN_ENC_KEY,
    BLIZZARD_MOCK: 'true',
    BLIZZARD_REGIONS: opts?.regions ?? 'us,eu',
    PUBLIC_WEB_ORIGIN: 'https://crusaderstrike.com',
    PUBLIC_API_ORIGIN: 'http://127.0.0.1',
    BLIZZARD_REDIRECT_URI: 'http://127.0.0.1/api/v1/auth/blizzard/callback',
    CORS_ORIGINS: 'https://crusaderstrike.com,https://www.crusaderstrike.com',
    COOKIE_SECURE: opts?.cookieSecure ? 'true' : 'false',
    ...(opts?.buildSha !== undefined ? { BUILD_SHA: opts.buildSha } : {}),
  });

  const blizzard = createBlizzardClient({
    ...mock.config,
    region: config.BLIZZARD_REGION,
    regions: config.BLIZZARD_REGIONS,
    redirectUri: config.BLIZZARD_REDIRECT_URI,
  });

  const app = await buildApp({
    config,
    pool,
    blizzard,
    redirectUri: config.BLIZZARD_REDIRECT_URI,
  });
  await app.ready();
  await app.clearRefreshCooldowns?.();

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
