-- Replace main/alt selection with per-character displayed flags (platform#41).
-- Backfill from character_selections.main_id || alt_ids, then drop that table.

ALTER TABLE characters
  ADD COLUMN IF NOT EXISTS displayed BOOLEAN NOT NULL DEFAULT false;

UPDATE characters c
SET displayed = true
WHERE EXISTS (
  SELECT 1
  FROM character_selections cs
  WHERE cs.user_id = c.user_id
    AND (c.id = cs.main_id OR c.id = ANY (cs.alt_ids))
);

DROP TABLE IF EXISTS character_selections;
