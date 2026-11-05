-- WoW Forever item catalog (Blizzard static-forever-{region} only).
CREATE TABLE IF NOT EXISTS forever_items (
  item_id         BIGINT PRIMARY KEY,
  name            TEXT NOT NULL,
  slot            TEXT NOT NULL,
  slot_aliases    TEXT[] NOT NULL DEFAULT '{}',
  inventory_type  TEXT NOT NULL,
  quality         TEXT NOT NULL,
  item_level      INT NOT NULL,
  required_level  INT NOT NULL DEFAULT 0,
  armor_type      TEXT,
  item_class      INT,
  item_subclass   INT,
  stats           JSONB,
  icon_url        TEXT,
  icon_name       TEXT,
  source          TEXT NOT NULL DEFAULT 'blizzard_forever',
  verified        BOOLEAN NOT NULL DEFAULT TRUE,
  region          TEXT NOT NULL DEFAULT 'us'
                  CHECK (region IN ('us', 'eu', 'kr', 'tw')),
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS forever_items_name_lower_idx
  ON forever_items (lower(name));

CREATE INDEX IF NOT EXISTS forever_items_slot_ilvl_idx
  ON forever_items (slot, item_level DESC, item_id);

CREATE INDEX IF NOT EXISTS forever_items_aliases_idx
  ON forever_items USING GIN (slot_aliases);

CREATE INDEX IF NOT EXISTS forever_items_armor_type_idx
  ON forever_items (armor_type)
  WHERE armor_type IS NOT NULL;

-- Singleton import metadata (build id / ETag seed).
CREATE TABLE IF NOT EXISTS forever_items_meta (
  id           INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  build_id     TEXT NOT NULL DEFAULT 'empty',
  item_count   INT NOT NULL DEFAULT 0,
  region       TEXT NOT NULL DEFAULT 'us',
  imported_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO forever_items_meta (id, build_id, item_count)
VALUES (1, 'empty', 0)
ON CONFLICT (id) DO NOTHING;
