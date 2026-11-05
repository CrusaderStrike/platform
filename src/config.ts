import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_WEB_ORIGIN: z.string().url().default('https://crusaderstrike.com'),
  PUBLIC_API_ORIGIN: z.string().url().default('https://api.crusaderstrike.com'),
  CORS_ORIGINS: z.string().default('https://crusaderstrike.com,https://www.crusaderstrike.com'),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  BLIZZARD_MOCK: bool.default(true),
  BLIZZARD_CLIENT_ID: z.string().optional().default(''),
  BLIZZARD_CLIENT_SECRET: z.string().optional().default(''),
  BLIZZARD_REGION: z.enum(['us', 'eu', 'kr', 'tw']).default('us'),
  BLIZZARD_OAUTH_AUTHORIZE_URL: z.string().url().default('https://oauth.battle.net/authorize'),
  BLIZZARD_OAUTH_TOKEN_URL: z.string().url().default('https://oauth.battle.net/token'),
  BLIZZARD_API_BASE_URL: z.string().url().default('https://us.api.blizzard.com'),
  BLIZZARD_REDIRECT_URI: z.string().url().default(
    'https://api.crusaderstrike.com/api/v1/auth/blizzard/callback',
  ),
  COOKIE_SECURE: bool.optional(),
});

export type Config = z.infer<typeof envSchema> & {
  corsOrigins: string[];
  cookieSecure: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  const corsOrigins = parsed.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const cookieSecure =
    parsed.COOKIE_SECURE ?? (parsed.NODE_ENV === 'production' || parsed.PUBLIC_WEB_ORIGIN.startsWith('https://'));
  if (!parsed.BLIZZARD_MOCK) {
    if (!parsed.BLIZZARD_CLIENT_ID || !parsed.BLIZZARD_CLIENT_SECRET) {
      throw new Error('BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET are required when BLIZZARD_MOCK=false');
    }
  }
  return { ...parsed, corsOrigins, cookieSecure };
}
