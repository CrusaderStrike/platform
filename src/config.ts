import { z } from 'zod';
import {
  apiBaseUrlForRegion,
  oauthAuthorizeUrlForRegion,
  oauthTokenUrlForRegion,
  parseRegionsList,
  type BlizzardRegion,
} from './blizzard/regions.js';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_WEB_ORIGIN: z.string().url().default('https://crusaderstrike.com'),
  PUBLIC_API_ORIGIN: z.string().url().default('https://api.crusaderstrike.com'),
  CORS_ORIGINS: z.string().default('https://crusaderstrike.com,https://www.crusaderstrike.com'),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  /** 32-byte AES-256-GCM key as 64 hex chars. Required always (encrypts Blizzard tokens at rest). */
  TOKEN_ENC_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'TOKEN_ENC_KEY must be 64 hex characters (32 bytes)'),
  /** Default false. Startup fails when NODE_ENV=production and this is true. */
  BLIZZARD_MOCK: bool.default(false),
  BLIZZARD_CLIENT_ID: z.string().optional().default(''),
  BLIZZARD_CLIENT_SECRET: z.string().optional().default(''),
  /**
   * Comma-separated Forever regions to sync (us,eu,kr,tw). Default: us.
   * First entry is the primary OAuth / preferred_region default.
   */
  BLIZZARD_REGIONS: z.string().default('us'),
  /** Optional override for primary region; must be in BLIZZARD_REGIONS. */
  BLIZZARD_REGION: z.enum(['us', 'eu', 'kr', 'tw']).optional(),
  BLIZZARD_REDIRECT_URI: z
    .string()
    .url()
    .default('https://api.crusaderstrike.com/api/v1/auth/blizzard/callback'),
  COOKIE_SECURE: bool.optional(),
});

export type Config = {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  PUBLIC_WEB_ORIGIN: string;
  PUBLIC_API_ORIGIN: string;
  CORS_ORIGINS: string;
  DATABASE_URL: string;
  SESSION_SECRET: string;
  TOKEN_ENC_KEY: string;
  BLIZZARD_MOCK: boolean;
  BLIZZARD_CLIENT_ID: string;
  BLIZZARD_CLIENT_SECRET: string;
  BLIZZARD_REGIONS: BlizzardRegion[];
  BLIZZARD_REGION: BlizzardRegion;
  BLIZZARD_OAUTH_AUTHORIZE_URL: string;
  BLIZZARD_OAUTH_TOKEN_URL: string;
  BLIZZARD_API_BASE_URL: string;
  BLIZZARD_REDIRECT_URI: string;
  corsOrigins: string[];
  cookieSecure: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const v = parsed.data;

  if (v.NODE_ENV === 'production' && v.BLIZZARD_MOCK) {
    throw new Error('Invalid configuration: BLIZZARD_MOCK must be false when NODE_ENV=production');
  }

  let regions: BlizzardRegion[];
  try {
    regions = parseRegionsList(v.BLIZZARD_REGIONS);
  } catch (err) {
    throw new Error(`Invalid configuration: ${err instanceof Error ? err.message : String(err)}`);
  }

  const primary = (v.BLIZZARD_REGION as BlizzardRegion | undefined) ?? regions[0]!;
  if (!regions.includes(primary)) {
    throw new Error(
      `Invalid configuration: BLIZZARD_REGION '${primary}' is not in BLIZZARD_REGIONS (${regions.join(',')})`,
    );
  }

  if (!v.BLIZZARD_MOCK) {
    if (!v.BLIZZARD_CLIENT_ID || !v.BLIZZARD_CLIENT_SECRET) {
      throw new Error(
        'Invalid configuration: BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET are required when BLIZZARD_MOCK=false',
      );
    }
  }

  const corsOrigins = v.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const cookieSecure =
    v.COOKIE_SECURE ??
    (v.NODE_ENV === 'production' || v.PUBLIC_WEB_ORIGIN.startsWith('https://'));

  return {
    NODE_ENV: v.NODE_ENV,
    PORT: v.PORT,
    PUBLIC_WEB_ORIGIN: v.PUBLIC_WEB_ORIGIN,
    PUBLIC_API_ORIGIN: v.PUBLIC_API_ORIGIN,
    CORS_ORIGINS: v.CORS_ORIGINS,
    DATABASE_URL: v.DATABASE_URL,
    SESSION_SECRET: v.SESSION_SECRET,
    TOKEN_ENC_KEY: v.TOKEN_ENC_KEY,
    BLIZZARD_MOCK: Boolean(v.BLIZZARD_MOCK),
    BLIZZARD_CLIENT_ID: v.BLIZZARD_CLIENT_ID,
    BLIZZARD_CLIENT_SECRET: v.BLIZZARD_CLIENT_SECRET,
    BLIZZARD_REGIONS: regions,
    BLIZZARD_REGION: primary,
    BLIZZARD_OAUTH_AUTHORIZE_URL: oauthAuthorizeUrlForRegion(primary),
    BLIZZARD_OAUTH_TOKEN_URL: oauthTokenUrlForRegion(primary),
    BLIZZARD_API_BASE_URL: apiBaseUrlForRegion(primary),
    BLIZZARD_REDIRECT_URI: v.BLIZZARD_REDIRECT_URI,
    corsOrigins,
    cookieSecure,
  };
}
