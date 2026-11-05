import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
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

/** Relative same-site path: single leading /, no //, no backslash. */
export function isSafeReturnTo(value: string | undefined | null): value is string {
  if (!value) return false;
  if (value.length > 512) return false;
  return /^\/(?![/\\])[^\\]*$/.test(value);
}
