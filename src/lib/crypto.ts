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

/**
 * Relative same-site path only.
 * Rejects control chars/whitespace, backslashes, and anything starting with // or /\.
 */
export function isSafeReturnTo(value: string | undefined | null): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false;
  if (/[\x00-\x1f\x7f\s]/.test(value)) return false;
  if (value.includes('\\')) return false;
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//') || value.startsWith('/\\')) return false;
  // After decoding once, still must be a single-slash relative path with no controls.
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  if (decoded !== value) {
    if (/[\x00-\x1f\x7f\s]/.test(decoded)) return false;
    if (decoded.includes('\\')) return false;
    if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.startsWith('/\\')) return false;
  }
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
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (url.origin !== base.origin) {
    throw new Error('unsafe_return_to_origin');
  }
  return url.toString();
}

const ENC_PREFIX = 'v1:';

/** AES-256-GCM; TOKEN_ENC_KEY is 32 raw bytes as 64 hex chars. */
export function encryptSecret(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('TOKEN_ENC_KEY must be 32 bytes (64 hex chars)');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptSecret(payload: string, keyHex: string): string {
  if (!payload.startsWith(ENC_PREFIX)) {
    // Legacy plaintext (dev only) — treat as already clear.
    return payload;
  }
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('TOKEN_ENC_KEY must be 32 bytes (64 hex chars)');
  const body = payload.slice(ENC_PREFIX.length);
  const [ivB64, tagB64, dataB64] = body.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('invalid_encrypted_secret');
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const data = Buffer.from(dataB64, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
