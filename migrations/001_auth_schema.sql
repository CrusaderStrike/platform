-- platform#11: users, sessions, OAuth state, Forever characters, selection, equipped gear
-- Establishes the app scaffold that #2 / #13 will extend for guild tenancy.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  battlenet_id    TEXT NOT NULL UNIQUE,
  battletag       TEXT NOT NULL,
  preferred_region TEXT NOT NULL DEFAULT 'us' CHECK (preferred_region IN ('us', 'eu')),
  access_token    TEXT,
  refresh_token   TEXT,
  token_expires_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token      TEXT NOT NULL,
  active_guild_id UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS oauth_states (
  state           TEXT PRIMARY KEY,
  code_verifier   TEXT NOT NULL,
  return_to       TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id                TEXT PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blizzard_char_id  BIGINT,
  character_name    TEXT NOT NULL,
  surname           TEXT,
  realm             TEXT,
  realm_id          INTEGER,
  region            TEXT NOT NULL DEFAULT 'us' CHECK (region IN ('us', 'eu')),
  faction           TEXT CHECK (faction IS NULL OR faction IN ('alliance', 'horde')),
  class             TEXT,
  race              TEXT,
  level             INTEGER,
  game              TEXT NOT NULL DEFAULT 'wow_forever' CHECK (game = 'wow_forever'),
  stale             BOOLEAN NOT NULL DEFAULT false,
  raw               JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS characters_user_id_idx ON characters(user_id);

CREATE TABLE IF NOT EXISTS character_selections (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  main_id     TEXT NOT NULL REFERENCES characters(id),
  alt_ids     TEXT[] NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS character_gear (
  character_id  TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  items         JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Schema migrations bookkeeping
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
