-- platform#3: addon dungeon-run + PvP uploads (guild stub until #2 fleshes tenancy)

CREATE TABLE IF NOT EXISTS guilds (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'personal'
              CHECK (kind IN ('personal', 'guild')),
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS guilds_personal_owner_uidx
  ON guilds (owner_user_id) WHERE kind = 'personal' AND owner_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS guild_members (
  guild_id    UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member'
              CHECK (role IN ('owner', 'officer', 'member')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX IF NOT EXISTS guild_members_user_id_idx ON guild_members(user_id);

CREATE TABLE IF NOT EXISTS dungeon_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id        UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id    TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  addon_run_id    TEXT NOT NULL,
  schema_version  INTEGER NOT NULL,
  game_version    TEXT NOT NULL CHECK (game_version = 'forever'),
  dungeon_id      INTEGER NOT NULL,
  dungeon_name    TEXT NOT NULL,
  difficulty      TEXT,
  started_at      TIMESTAMPTZ NOT NULL,
  completed_at    TIMESTAMPTZ,
  duration_ms     INTEGER,
  completed       BOOLEAN NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('in_progress', 'closed', 'completed')),
  party           JSONB NOT NULL DEFAULT '[]'::jsonb,
  bosses          JSONB NOT NULL DEFAULT '[]'::jsonb,
  deaths          JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_payload     JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (character_id, addon_run_id)
);

CREATE INDEX IF NOT EXISTS dungeon_runs_user_id_idx ON dungeon_runs(user_id);
CREATE INDEX IF NOT EXISTS dungeon_runs_character_id_idx ON dungeon_runs(character_id);

CREATE TABLE IF NOT EXISTS pvp_world_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id        UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id    TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  addon_pvp_id    TEXT NOT NULL,
  record_version  INTEGER NOT NULL DEFAULT 1,
  occurred_at     TIMESTAMPTZ NOT NULL,
  zone            TEXT,
  subzone         TEXT,
  result          TEXT NOT NULL CHECK (result IN ('kill', 'death')),
  honorable       BOOLEAN NOT NULL,
  killer_source   TEXT CHECK (killer_source IS NULL OR killer_source IN ('target', 'combat_log')),
  opponent        JSONB,
  raw_payload     JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (character_id, addon_pvp_id)
);

CREATE INDEX IF NOT EXISTS pvp_world_events_user_id_idx ON pvp_world_events(user_id);

CREATE TABLE IF NOT EXISTS pvp_battlegrounds (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id        UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id    TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  addon_pvp_id    TEXT NOT NULL,
  record_version  INTEGER NOT NULL DEFAULT 1,
  map_id          INTEGER NOT NULL,
  map_name        TEXT NOT NULL,
  faction         TEXT CHECK (faction IS NULL OR faction IN ('alliance', 'horde')),
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ NOT NULL,
  duration_sec    INTEGER NOT NULL,
  result          TEXT NOT NULL CHECK (result IN ('win', 'loss', 'left', 'draw')),
  winner          INTEGER CHECK (winner IS NULL OR winner IN (0, 1, 255)),
  stats           JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_payload     JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (character_id, addon_pvp_id)
);

CREATE INDEX IF NOT EXISTS pvp_battlegrounds_user_id_idx ON pvp_battlegrounds(user_id);

CREATE TABLE IF NOT EXISTS upload_rate_limits (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_at     TIMESTAMPTZ NOT NULL
);
