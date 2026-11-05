-- Cache Blizzard Item Media icon URLs by item id (region-scoped).
CREATE TABLE IF NOT EXISTS item_icon_cache (
  item_id     BIGINT NOT NULL,
  region      TEXT NOT NULL CHECK (region IN ('us', 'eu', 'kr', 'tw')),
  icon_url    TEXT,
  icon_name   TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, region)
);
