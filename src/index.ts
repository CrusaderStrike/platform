import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createBlizzardClient } from './blizzard/client.js';
import { startMockBlizzard } from './blizzard/mock.js';
import { buildApp } from './app.js';
import { startNoopRetentionJob } from './gear/noop-retention.js';

async function main() {
  const config = loadConfig();
  await migrate(config.DATABASE_URL);
  const pool = createPool(config.DATABASE_URL);

  let blizzard = createBlizzardClient({
    clientId: config.BLIZZARD_CLIENT_ID || 'unused',
    clientSecret: config.BLIZZARD_CLIENT_SECRET || 'unused',
    region: config.BLIZZARD_REGION,
    regions: config.BLIZZARD_REGIONS,
    authorizeUrl: config.oauthAuthorizeUrl,
    tokenUrl: config.oauthTokenUrl,
    apiBaseUrl: config.apiBaseUrl,
    redirectUri: config.BLIZZARD_REDIRECT_URI,
  });

  if (config.BLIZZARD_MOCK) {
    const mock = await startMockBlizzard();
    blizzard = createBlizzardClient({
      ...mock.config,
      regions: config.BLIZZARD_REGIONS,
      region: config.BLIZZARD_REGION,
      redirectUri: config.BLIZZARD_REDIRECT_URI,
    });
    (globalThis as { __csMockBlizzard?: unknown }).__csMockBlizzard = mock;
    console.log(`Blizzard mock listening on ${mock.baseUrl}`);
  }

  const app = await buildApp({ config, pool, blizzard });
  // Cheap in-process prune for gear_op_noop_ids (platform#47). No external cron.
  const noopRetention =
    config.NODE_ENV === 'test'
      ? null
      : startNoopRetentionJob(pool, {
          retentionDays: config.GEAR_OP_NOOP_RETENTION_DAYS,
        });
  app.addHook('onClose', async () => {
    noopRetention?.stop();
  });
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
