import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createBlizzardClient } from './blizzard/client.js';
import { startMockBlizzard } from './blizzard/mock.js';
import { buildApp } from './app.js';

async function main() {
  const config = loadConfig();
  await migrate(config.DATABASE_URL);
  const pool = createPool(config.DATABASE_URL);

  let blizzard = createBlizzardClient({
    clientId: config.BLIZZARD_CLIENT_ID || 'unused',
    clientSecret: config.BLIZZARD_CLIENT_SECRET || 'unused',
    region: config.BLIZZARD_REGION === 'eu' ? 'eu' : 'us',
    authorizeUrl: config.BLIZZARD_OAUTH_AUTHORIZE_URL,
    tokenUrl: config.BLIZZARD_OAUTH_TOKEN_URL,
    apiBaseUrl: config.BLIZZARD_API_BASE_URL,
    redirectUri: config.BLIZZARD_REDIRECT_URI,
  });

  if (config.BLIZZARD_MOCK) {
    const mock = await startMockBlizzard();
    blizzard = mock.client;
    // Point authorize/token/api at the mock by rebuilding client from mock config,
    // and rewrite redirect to our local callback when developing.
    blizzard = createBlizzardClient({
      ...mock.config,
      redirectUri: config.BLIZZARD_REDIRECT_URI,
    });
    // Keep mock process alive for the server lifetime.
    (globalThis as { __csMockBlizzard?: unknown }).__csMockBlizzard = mock;
    console.log(`Blizzard mock listening on ${mock.baseUrl}`);
  }

  const app = await buildApp({ config, pool, blizzard });
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
