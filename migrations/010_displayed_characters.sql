-- Displayed characters (platform#41). Keep character_selections for one release
-- so a rollback of app code is not lossy; drop main/alt columns in a later migration.

ALTER TABLE characters
  ADD COLUMN IF NOT EXISTS displayed BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE character_selections
  ADD COLUMN IF NOT EXISTS displayed_character_ids TEXT[] NOT NULL DEFAULT '{}';

-- Backfill display set: main first, then alts (dedupe, preserve order).
UPDATE character_selections
SET displayed_character_ids = (
  SELECT COALESCE(array_agg(id ORDER BY ord), '{}'::text[])
  FROM (
    SELECT id, MIN(ord) AS ord
    FROM (
      SELECT main_id AS id, 0 AS ord
      UNION ALL
      SELECT a, 1000 + o::int
      FROM unnest(alt_ids) WITH ORDINALITY AS t(a, o)
    ) s
    WHERE id IS NOT NULL
    GROUP BY id
  ) d
);

UPDATE characters c
SET displayed = true
WHERE EXISTS (
  SELECT 1
  FROM character_selections cs
  WHERE cs.user_id = c.user_id
    AND c.id = ANY (cs.displayed_character_ids)
);

-- main_id / alt_ids remain for this release (compat + rollback).
