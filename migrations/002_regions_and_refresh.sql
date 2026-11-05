-- Expand Forever regions and persist character refresh cooldown.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_preferred_region_check;
ALTER TABLE users
  ADD CONSTRAINT users_preferred_region_check
  CHECK (preferred_region IN ('us', 'eu', 'kr', 'tw'));

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_refreshed_at TIMESTAMPTZ;

ALTER TABLE characters DROP CONSTRAINT IF EXISTS characters_region_check;
ALTER TABLE characters
  ADD CONSTRAINT characters_region_check
  CHECK (region IN ('us', 'eu', 'kr', 'tw'));
