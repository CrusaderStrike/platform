-- platform#37: public guild + recruiting read API fields (Forever only)

ALTER TABLE guilds
  ADD COLUMN IF NOT EXISTS realm_slug TEXT,
  ADD COLUMN IF NOT EXISTS realm_name TEXT,
  ADD COLUMN IF NOT EXISTS guild_slug TEXT,
  ADD COLUMN IF NOT EXISTS region TEXT
    CHECK (region IS NULL OR region IN ('us', 'eu', 'kr', 'tw')),
  ADD COLUMN IF NOT EXISTS faction TEXT
    CHECK (faction IS NULL OR faction IN ('alliance', 'horde')),
  ADD COLUMN IF NOT EXISTS pitch TEXT
    CHECK (pitch IS NULL OR char_length(pitch) <= 500),
  ADD COLUMN IF NOT EXISTS recruiting BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS public_listed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS open_roles TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS recruiting_needs JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS raid_schedule JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS raid_timezone TEXT,
  ADD COLUMN IF NOT EXISTS contact JSONB,
  ADD COLUMN IF NOT EXISTS public_member_count INTEGER
    CHECK (public_member_count IS NULL OR (public_member_count >= 0 AND public_member_count <= 1000)),
  ADD COLUMN IF NOT EXISTS emblem_url TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- Personal tenants never get public slugs; uniqueness among real guilds with slugs.
CREATE UNIQUE INDEX IF NOT EXISTS guilds_public_slug_uidx
  ON guilds (realm_slug, guild_slug)
  WHERE kind = 'guild' AND realm_slug IS NOT NULL AND guild_slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS guilds_public_browse_idx
  ON guilds (public_listed, realm_slug, faction, updated_at DESC, id)
  WHERE kind = 'guild' AND public_listed = true;

-- Anonymous per-IP rate limits for public GETs (platform#37).
CREATE TABLE IF NOT EXISTS public_api_rate_limits (
  ip_hash       TEXT NOT NULL,
  bucket        TEXT NOT NULL,
  window_start  TIMESTAMPTZ NOT NULL,
  hit_count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, bucket)
);
