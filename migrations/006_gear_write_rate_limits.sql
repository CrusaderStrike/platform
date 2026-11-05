-- Dedicated gear write cooldown (~60 writes/min). Separate from upload_rate_limits.
CREATE TABLE IF NOT EXISTS gear_write_rate_limits (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_at     TIMESTAMPTZ NOT NULL
);
