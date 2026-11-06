-- Forever item sets + class restrictions for the equip-rules engine (platform#78).
-- Additive: existing forever_items rows keep NULL allowed_classes / item_set_id until re-import.

ALTER TABLE forever_items
  ADD COLUMN IF NOT EXISTS allowed_classes TEXT[],
  ADD COLUMN IF NOT EXISTS item_set_id INT;

CREATE INDEX IF NOT EXISTS forever_items_item_set_id_idx
  ON forever_items (item_set_id)
  WHERE item_set_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS forever_items_allowed_classes_idx
  ON forever_items USING GIN (allowed_classes)
  WHERE allowed_classes IS NOT NULL;

CREATE TABLE IF NOT EXISTS forever_item_sets (
  id               INT PRIMARY KEY,
  name             TEXT NOT NULL,
  effects          JSONB,
  allowed_classes  TEXT[],
  class_source     TEXT CHECK (class_source IS NULL OR class_source IN ('items', 'inferred', 'manual')),
  build_id         TEXT NOT NULL DEFAULT 'empty',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS forever_item_set_items (
  set_id   INT NOT NULL REFERENCES forever_item_sets (id) ON DELETE CASCADE,
  item_id  BIGINT NOT NULL,
  PRIMARY KEY (set_id, item_id)
);

CREATE INDEX IF NOT EXISTS forever_item_set_items_item_id_idx
  ON forever_item_set_items (item_id);

ALTER TABLE forever_items_meta
  ADD COLUMN IF NOT EXISTS set_count INT NOT NULL DEFAULT 0;
