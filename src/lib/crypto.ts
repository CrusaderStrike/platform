import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

export function newRequestId(): string {
  return randomUUID();
}

export function sha256Base64Url(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Decode URI component exactly once. Returns null on malformed encoding. */
export function normalizeReturnTo(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Relative same-site path only (platform#64).
 * Decode once, then require a single leading `/`. Reject `//`, scheme/host, backslash,
 * control chars/whitespace, and residual encoded `/` or `\` after that one decode.
 */
export function isSafeReturnTo(value: string | undefined | null): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false;
  if (/[\x00-\x1f\x7f\s]/.test(value)) return false;
  if (value.includes('\\')) return false;
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//') || value.startsWith('/\\')) return false;
  // Absolute / scheme-looking after the leading slash (e.g. /https://…).
  if (/^\/[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false;

  const normalized = normalizeReturnTo(value);
  if (normalized === null) return false;
  if (/[\x00-\x1f\x7f\s]/.test(normalized)) return false;
  if (normalized.includes('\\')) return false;
  if (!normalized.startsWith('/')) return false;
  if (normalized.startsWith('//') || normalized.startsWith('/\\')) return false;
  if (/^\/[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)) return false;
  // After one decode, reject residual encoded slash/backslash that would enable a second hop.
  if (/%2f|%5c/i.test(normalized)) return false;
  return true;
}

/** Resolve return_to against the site origin; throw if the result leaves that origin. */
export function safeWebRedirect(
  siteOrigin: string,
  returnTo: string,
  params: Record<string, string> = {},
): string {
  if (!isSafeReturnTo(returnTo)) {
    throw new Error('unsafe_return_to');
  }
  const base = new URL(siteOrigin);
  const url = new URL(returnTo, base);
  if (url.origin !== base.origin) {
    throw new Error('unsafe_return_to_origin');
  }
  // Pathname after URL parsing must still be a same-origin relative path (not protocol-relative).
  if (url.pathname.startsWith('//')) {
    throw new Error('unsafe_return_to');
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (url.origin !== base.origin) {
    throw new Error('unsafe_return_to_origin');
  }
  return url.toString();
}

/** Current ciphertext version prefix. */
export const ENC_PREFIX = 'v1:';

/**
 * Known placeholder keys from .env.example and docker-compose.
 * Production must never use these. Never log the actual key value.
 */
export const FORBIDDEN_TOKEN_ENC_KEYS = new Set([
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
]);

/**
 * Heuristic weak-key detection (platform#66). `openssl rand -hex 32` output essentially
 * never trips these: it has ~14-16 distinct hex digits and no short repeating period.
 */
export function isWeakKeyMaterial(lowerHex: string): boolean {
  // Too few distinct hex digits (e.g. "0101…", "deadbeef…" repeated).
  if (new Set(lowerHex).size < 8) return true;
  // Short repeating period (any block of <=16 chars repeated across the key).
  for (let period = 1; period <= 16; period++) {
    if (64 % period !== 0) continue;
    if (lowerHex.slice(0, period).repeat(64 / period) === lowerHex) return true;
  }
  // Monotonic hex runs like 0123456789abcdef… / fedcba98… (cyclic).
  const digits = [...lowerHex].map((c) => parseInt(c, 16));
  let up = 0;
  let down = 0;
  for (let i = 1; i < digits.length; i++) {
    if (digits[i]! === (digits[i - 1]! + 1) % 16) up++;
    if (digits[i]! === (digits[i - 1]! + 15) % 16) down++;
  }
  if (up >= 48 || down >= 48) return true;
  return false;
}

export type TokenKeyValidation =
  | { ok: true; keyHex: string }
  | { ok: false; reason: string };

/** Validate a TOKEN_ENC_KEY hex string without echoing the value. */
export function validateTokenEncKey(raw: string | undefined | null): TokenKeyValidation {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: false, reason: 'TOKEN_ENC_KEY is missing' };
  }
  if (typeof raw !== 'string' || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    return {
      ok: false,
      reason: 'TOKEN_ENC_KEY must be 64 hex characters (32 bytes)',
    };
  }
  const key = Buffer.from(raw, 'hex');
  if (key.length !== 32) {
    return { ok: false, reason: 'TOKEN_ENC_KEY must decode to 32 bytes' };
  }
  const lower = raw.toLowerCase();
  if (FORBIDDEN_TOKEN_ENC_KEYS.has(lower)) {
    return {
      ok: false,
      reason: 'TOKEN_ENC_KEY must not be the example/placeholder value',
    };
  }
  // Low entropy: all identical hex digits (e.g. 0000… or aaaa…).
  if (/^(.)\1{63}$/i.test(raw)) {
    return { ok: false, reason: 'TOKEN_ENC_KEY is low-entropy' };
  }
  if (isWeakKeyMaterial(lower)) {
    return { ok: false, reason: 'TOKEN_ENC_KEY is low-entropy' };
  }
  return { ok: true, keyHex: lower };
}

export class TokenDecryptError extends Error {
  constructor(
    message: string,
    public code: 'missing_prefix' | 'decrypt_failed' | 'invalid_payload',
  ) {
    super(message);
    this.name = 'TokenDecryptError';
  }
}

/** AES-256-GCM; TOKEN_ENC_KEY is 32 raw bytes as 64 hex chars. Always writes v1: prefix. */
export function encryptSecret(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('TOKEN_ENC_KEY must be 32 bytes (64 hex chars)');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decryptWithKey(payloadBody: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('TOKEN_ENC_KEY must be 32 bytes (64 hex chars)');
  const [ivB64, tagB64, dataB64] = payloadBody.split('.');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new TokenDecryptError('invalid encrypted secret', 'invalid_payload');
  }
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const data = Buffer.from(dataB64, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/**
 * Decrypt a stored secret. Requires the `v1:` prefix — plaintext / unprefixed values
 * are never accepted (force re-login). Optionally tries TOKEN_ENC_KEY_PREVIOUS
 * (decrypt-only) during key rotation.
 */
export function decryptSecret(
  payload: string,
  keyHex: string,
  opts?: { previousKeyHex?: string },
): string {
  if (!payload.startsWith(ENC_PREFIX)) {
    throw new TokenDecryptError(
      'stored token missing v1: prefix; re-login required',
      'missing_prefix',
    );
  }
  const body = payload.slice(ENC_PREFIX.length);
  try {
    return decryptWithKey(body, keyHex);
  } catch (err) {
    if (err instanceof TokenDecryptError) throw err;
    if (opts?.previousKeyHex) {
      try {
        return decryptWithKey(body, opts.previousKeyHex);
      } catch {
        throw new TokenDecryptError('token decrypt failed', 'decrypt_failed');
      }
    }
    throw new TokenDecryptError('token decrypt failed', 'decrypt_failed');
  }
}
