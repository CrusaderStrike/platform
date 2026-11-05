import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  decryptSecret,
  encryptSecret,
  isWeakKeyMaterial,
  TokenDecryptError,
  validateTokenEncKey,
} from '../src/lib/crypto.js';
import { PROD_SAFE_TOKEN_ENC_KEY, TEST_TOKEN_ENC_KEY } from './helpers/setup.js';

// platform#66 — TOKEN_ENC_KEY production hardening.
const base = {
  DATABASE_URL: 'postgres://x:x@127.0.0.1:5432/x',
  SESSION_SECRET: 'test-session-secret-at-least-32-chars!!',
  BLIZZARD_CLIENT_ID: 'id',
  BLIZZARD_CLIENT_SECRET: 'secret',
  NODE_ENV: 'production',
};

function bootError(env: Record<string, string | undefined>): string {
  try {
    loadConfig({ ...base, ...env } as NodeJS.ProcessEnv);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected loadConfig to throw');
}

const rejectCases: Array<[string, string | undefined, RegExp]> = [
  ['missing', undefined, /TOKEN_ENC_KEY/],
  ['empty', '', /TOKEN_ENC_KEY/],
  ['example value', TEST_TOKEN_ENC_KEY, /example\/placeholder/],
  ['example value uppercased', TEST_TOKEN_ENC_KEY.toUpperCase(), /example\/placeholder/],
  ['non-hex', 'zz'.repeat(32), /64 hex/],
  ['base64 instead of hex', Buffer.alloc(32, 7).toString('base64'), /64 hex/],
  ['too short (16 bytes)', PROD_SAFE_TOKEN_ENC_KEY.slice(0, 32), /64 hex/],
  ['too long', PROD_SAFE_TOKEN_ENC_KEY + 'ab', /64 hex/],
  ['whitespace padded', ` ${PROD_SAFE_TOKEN_ENC_KEY}`, /64 hex/],
  ['all identical', 'a'.repeat(64), /low-entropy/],
  ['two-char repeat', '01'.repeat(32), /low-entropy/],
  ['short period repeat', 'deadbeef'.repeat(8), /low-entropy/],
  ['16-char period repeat', '0f1e2d3c4b5a6978'.repeat(4), /low-entropy/],
  ['monotonic run', 'fedcba9876543210'.repeat(4), /low-entropy/],
];

describe('TOKEN_ENC_KEY production boot validation (#66)', () => {
  it.each(rejectCases)('refuses to boot: %s', (_label, key, re) => {
    const msg = bootError({ TOKEN_ENC_KEY: key });
    expect(msg).toMatch(re);
    if (key && key.length >= 8) {
      // Never echo the key or any recognizable fragment.
      expect(msg).not.toContain(key);
      expect(msg.toLowerCase()).not.toContain(key.trim().slice(0, 8).toLowerCase());
    }
  });

  it('boots with a random key', () => {
    const cfg = loadConfig({ ...base, TOKEN_ENC_KEY: PROD_SAFE_TOKEN_ENC_KEY } as NodeJS.ProcessEnv);
    expect(cfg.TOKEN_ENC_KEY).toBe(PROD_SAFE_TOKEN_ENC_KEY);
  });

  it('openssl-style random keys never trip the weak heuristic', () => {
    for (let i = 0; i < 2000; i++) {
      const k = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
      expect(isWeakKeyMaterial(k)).toBe(false);
      expect(validateTokenEncKey(k).ok).toBe(true);
    }
  });

  it('non-production still allows the example key for local compose', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'development', TOKEN_ENC_KEY: TEST_TOKEN_ENC_KEY } as NodeJS.ProcessEnv);
    expect(cfg.isProduction).toBe(false);
  });

  it('APP_ENV=production is treated as production', () => {
    expect(bootError({ NODE_ENV: 'development', APP_ENV: 'production', TOKEN_ENC_KEY: TEST_TOKEN_ENC_KEY })).toMatch(
      /example\/placeholder/,
    );
  });

  it.each([
    ['example value', TEST_TOKEN_ENC_KEY, /TOKEN_ENC_KEY_PREVIOUS must not be the example/],
    ['weak', 'ab'.repeat(32), /TOKEN_ENC_KEY_PREVIOUS is low-entropy/],
    ['invalid format', 'nothex', /TOKEN_ENC_KEY_PREVIOUS must be 64 hex/],
    ['same as current', PROD_SAFE_TOKEN_ENC_KEY, /must differ/],
  ])('refuses to boot with TOKEN_ENC_KEY_PREVIOUS %s', (_l, prev, re) => {
    const msg = bootError({ TOKEN_ENC_KEY: PROD_SAFE_TOKEN_ENC_KEY, TOKEN_ENC_KEY_PREVIOUS: prev });
    expect(msg).toMatch(re);
    expect(msg).not.toContain(PROD_SAFE_TOKEN_ENC_KEY.slice(0, 8));
  });
});

describe('stored token v1: prefix (#66)', () => {
  it.each(['access_plain', 'v2:abc.def.ghi', 'V1:abc.def.ghi', ''])(
    'rejects token without v1: prefix (%s) as missing_prefix',
    (payload) => {
      try {
        decryptSecret(payload, PROD_SAFE_TOKEN_ENC_KEY);
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(TokenDecryptError);
        expect((err as TokenDecryptError).code).toBe('missing_prefix');
      }
    },
  );

  it('round-trips v1: tokens', () => {
    const enc = encryptSecret('tok', PROD_SAFE_TOKEN_ENC_KEY);
    expect(enc.startsWith('v1:')).toBe(true);
    expect(decryptSecret(enc, PROD_SAFE_TOKEN_ENC_KEY)).toBe('tok');
  });
});
