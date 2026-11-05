import { z } from 'zod';
import {
  apiBaseUrlForRegion,
  oauthAuthorizeUrlForRegion,
  oauthTokenUrlForRegion,
  parseRegionsList,
  type BlizzardRegion,
} from './blizzard/regions.js';
import { validateTokenEncKey } from './lib/crypto.js';
import {
  GEAR_OP_NOOP_RETENTION_DAYS_DEFAULT,
  resolveRetentionDays,
} from './gear/noop-retention.js';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Optional alias; treated like production when set to "production". */
  APP_ENV: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_WEB_ORIGIN: z.string().url().default('https://crusaderstrike.com'),
  PUBLIC_API_ORIGIN: z.string().url().default('https://api.crusaderstrike.com'),
  CORS_ORIGINS: z.string().default('https://crusaderstrike.com,https://www.crusaderstrike.com'),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  /** 32-byte AES-256-GCM key as 64 hex chars. Required always (encrypts Blizzard tokens at rest). */
  TOKEN_ENC_KEY: z.string().min(1),
  /**
   * Optional previous key for decrypt-only during rotation. Same format as TOKEN_ENC_KEY.
   * New writes always use TOKEN_ENC_KEY.
   */
  TOKEN_ENC_KEY_PREVIOUS: z.string().optional(),
  /** Default false. Startup fails when production and this is true. */
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
  /**
   * Comma-separated IPs/CIDRs of reverse proxies whose X-Forwarded-* we trust
   * (Fastify trustProxy). Empty/false disables. Default: RFC1918 private ranges
   * (Caddy on the docker network). Deploy: append TRUSTED_PROXY to api.env if
   * the default is wrong for the host network.
   */
  TRUSTED_PROXY: z.string().default('10.0.0.0/8,172.16.0.0/12,192.168.0.0/16'),
  /**
   * Days to keep gear_op_noop_ids markers for idempotent set_slot/clear_slot retries.
   * Integer 1..3650. Default 30. See docs/runbook.md § gear_op_noop_ids retention.
   */
  GEAR_OP_NOOP_RETENTION_DAYS: z.string().optional(),
});

export type Config = {
  NODE_ENV: 'development' | 'test' | 'production';
  isProduction: boolean;
  PORT: number;
  PUBLIC_WEB_ORIGIN: string;
  PUBLIC_API_ORIGIN: string;
  CORS_ORIGINS: string;
  DATABASE_URL: string;
  SESSION_SECRET: string;
  TOKEN_ENC_KEY: string;
  TOKEN_ENC_KEY_PREVIOUS?: string;
  BLIZZARD_MOCK: boolean;
  BLIZZARD_CLIENT_ID: string;
  BLIZZARD_CLIENT_SECRET: string;
  BLIZZARD_REGIONS: BlizzardRegion[];
  BLIZZARD_REGION: BlizzardRegion;
  /** Derived OAuth authorize URL (not an env var). */
  oauthAuthorizeUrl: string;
  /** Derived OAuth token URL (not an env var). */
  oauthTokenUrl: string;
  /** Derived Game Data API base for the primary region (not an env var). */
  apiBaseUrl: string;
  BLIZZARD_REDIRECT_URI: string;
  corsOrigins: string[];
  cookieSecure: boolean;
  /** Fastify trustProxy value: false | true | CIDR list. */
  trustProxy: boolean | string[];
  /** Days to retain gear_op_noop_ids rows (validated 1..3650). */
  GEAR_OP_NOOP_RETENTION_DAYS: number;
};

function isProdEnv(nodeEnv: string, appEnv?: string): boolean {
  return nodeEnv === 'production' || (appEnv ?? '').toLowerCase() === 'production';
}


/** Parse TRUSTED_PROXY env into a Fastify trustProxy option. */
export function parseTrustedProxy(raw: string | undefined): boolean | string[] {
  const v = (raw ?? '').trim();
  if (!v || v === 'false' || v === '0' || v.toLowerCase() === 'no') return false;
  if (v === 'true' || v === '1' || v.toLowerCase() === 'yes') return true;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Never include raw env values (could contain secrets) in the message.
    const msg = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const v = parsed.data;
  const production = isProdEnv(v.NODE_ENV, v.APP_ENV);

  // TOKEN_ENC_KEY: always require 64 hex / 32 bytes. Production also rejects
  // placeholder and low-entropy keys. Never include the key value in errors.
  const formatOk = typeof v.TOKEN_ENC_KEY === 'string' && /^[0-9a-fA-F]{64}$/.test(v.TOKEN_ENC_KEY);
  if (!formatOk) {
    throw new Error(
      'Invalid configuration: TOKEN_ENC_KEY must be 64 hex characters (32 bytes)',
    );
  }
  const keyCheck = validateTokenEncKey(v.TOKEN_ENC_KEY);
  if (production && !keyCheck.ok) {
    throw new Error(`Invalid configuration: ${keyCheck.reason}`);
  }
  if (!production && !keyCheck.ok) {
    // Non-prod may use the documented example key or a weak local key for compose.
    if (
      keyCheck.reason !== 'TOKEN_ENC_KEY must not be the example/placeholder value' &&
      keyCheck.reason !== 'TOKEN_ENC_KEY is low-entropy'
    ) {
      throw new Error(`Invalid configuration: ${keyCheck.reason}`);
    }
  }
  const tokenKey = v.TOKEN_ENC_KEY.toLowerCase();

  let previous: string | undefined;
  if (v.TOKEN_ENC_KEY_PREVIOUS) {
    if (!/^[0-9a-fA-F]{64}$/.test(v.TOKEN_ENC_KEY_PREVIOUS)) {
      throw new Error(
        'Invalid configuration: TOKEN_ENC_KEY_PREVIOUS must be 64 hex characters (32 bytes)',
      );
    }
    previous = v.TOKEN_ENC_KEY_PREVIOUS.toLowerCase();
  }

  if (production && v.BLIZZARD_MOCK) {
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
    (production || v.PUBLIC_WEB_ORIGIN.startsWith('https://'));
  const trustProxy = parseTrustedProxy(v.TRUSTED_PROXY);
  let gearOpNoopRetentionDays: number;
  try {
    gearOpNoopRetentionDays = resolveRetentionDays(
      v.GEAR_OP_NOOP_RETENTION_DAYS,
      GEAR_OP_NOOP_RETENTION_DAYS_DEFAULT,
    );
  } catch (err) {
    throw new Error(`Invalid configuration: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    NODE_ENV: v.NODE_ENV,
    isProduction: production,
    PORT: v.PORT,
    PUBLIC_WEB_ORIGIN: v.PUBLIC_WEB_ORIGIN,
    PUBLIC_API_ORIGIN: v.PUBLIC_API_ORIGIN,
    CORS_ORIGINS: v.CORS_ORIGINS,
    DATABASE_URL: v.DATABASE_URL,
    SESSION_SECRET: v.SESSION_SECRET,
    TOKEN_ENC_KEY: tokenKey,
    TOKEN_ENC_KEY_PREVIOUS: previous,
    BLIZZARD_MOCK: Boolean(v.BLIZZARD_MOCK),
    BLIZZARD_CLIENT_ID: v.BLIZZARD_CLIENT_ID,
    BLIZZARD_CLIENT_SECRET: v.BLIZZARD_CLIENT_SECRET,
    BLIZZARD_REGIONS: regions,
    BLIZZARD_REGION: primary,
    oauthAuthorizeUrl: oauthAuthorizeUrlForRegion(primary),
    oauthTokenUrl: oauthTokenUrlForRegion(primary),
    apiBaseUrl: apiBaseUrlForRegion(primary),
    BLIZZARD_REDIRECT_URI: v.BLIZZARD_REDIRECT_URI,
    corsOrigins,
    cookieSecure,
    trustProxy,
    GEAR_OP_NOOP_RETENTION_DAYS: gearOpNoopRetentionDays,
  };
}
