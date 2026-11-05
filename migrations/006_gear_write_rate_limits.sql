-- Dedicated gear write rate limit: ~60 writes per rolling minute (no min interval).
-- Separate from upload_rate_limits so gear edits never contend with /uploads.
CREATE TABLE IF NOT EXISTS gear_write_rate_limits (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  window_start  TIMESTAMPTZ NOT NULL,
  write_count   INT NOT NULL DEFAULT 0 CHECK (write_count >= 0)
);
