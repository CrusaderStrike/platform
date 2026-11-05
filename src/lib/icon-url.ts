/** Only Blizzard CDN host we ever emit for gear icons. */
export const BLIZZARD_ICON_HOST = 'render.worldofwarcraft.com';

/**
 * Accept only https URLs whose host is exactly render.worldofwarcraft.com.
 * Uses WHATWG URL parsing so lookalikes (evil.com suffix, userinfo tricks) fail.
 * Returns null for http, wrong host, lookalike host, or malformed input.
 */
export function sanitizeBlizzardIconUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname !== BLIZZARD_ICON_HOST) return null;
  return url.href;
}

export function iconNameFromUrl(iconUrl: string | null): string | null {
  if (!iconUrl) return null;
  const m = iconUrl.match(/\/([a-zA-Z0-9_-]+)\.(jpg|png|webp)(?:\?|$)/i);
  return m?.[1] ?? null;
}
