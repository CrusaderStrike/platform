-- platform#17: event-sourced gear wishlists (log is truth; projections updated in same txn).
-- Tenancy stub consistent with #3/#4 guilds; full #2 RLS story still pending for other tables.
-- icon_url is never stored here; Forever item media stays null until Blizzard documents a static namespace.

CREATE OR REPLACE FUNCTION app_current_guild_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.guild_id', true), '')::uuid
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crusaderstrike_app') THEN
    CREATE ROLE crusaderstrike_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crusaderstrike_migrate') THEN
    CREATE ROLE crusaderstrike_migrate NOLOGIN;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS gear_lists (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id        UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  character_id    TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  owner_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
  version         BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  visibility      TEXT NOT NULL DEFAULT 'private'
                  CHECK (visibility IN ('private', 'guild')),
  deleted_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_source  TEXT CHECK (
                    updated_source IS NULL OR
                    updated_source IN ('web', 'addon', 'companion', 'export', 'system')
                  ),
  updated_by      TEXT
);

CREATE INDEX IF NOT EXISTS gear_lists_character_id_idx
  ON gear_lists (character_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS gear_lists_guild_id_idx ON gear_lists (guild_id);
CREATE UNIQUE INDEX IF NOT EXISTS gear_lists_active_name_per_character_uidx
  ON gear_lists (character_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS gear_list_items (
  guild_id        UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  list_id         UUID NOT NULL REFERENCES gear_lists(id) ON DELETE CASCADE,
  slot            TEXT NOT NULL,
  item_id         INTEGER NOT NULL CHECK (item_id > 0),
  priority        INTEGER NOT NULL CHECK (priority >= 1),
  note            TEXT CHECK (note IS NULL OR char_length(note) <= 200),
  obtained        BOOLEAN NOT NULL DEFAULT false,
  obtained_at     TIMESTAMPTZ,
  PRIMARY KEY (list_id, slot, item_id)
);

CREATE INDEX IF NOT EXISTS gear_list_items_guild_id_idx ON gear_list_items (guild_id);

CREATE TABLE IF NOT EXISTS gear_list_events (
  guild_id         UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  list_id          UUID NOT NULL REFERENCES gear_lists(id) ON DELETE CASCADE,
  seq              BIGINT NOT NULL CHECK (seq >= 1),
  event_type       TEXT NOT NULL CHECK (event_type IN (
                     'GearListCreated',
                     'GearListRenamed',
                     'GearListDeleted',
                     'GearItemAdded',
                     'GearItemRemoved',
                     'GearItemReprioritized',
                     'GearItemObtained',
                     'GearOpRejected'
                   )),
  schema_ver       INTEGER NOT NULL DEFAULT 1 CHECK (schema_ver >= 1),
  payload          JSONB NOT NULL,
  source           TEXT NOT NULL CHECK (source IN ('web', 'addon', 'companion', 'export', 'system')),
  actor            TEXT,
  idempotency_key  TEXT NOT NULL,
  occurred_at      TIMESTAMPTZ,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, list_id, seq),
  UNIQUE (guild_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS gear_list_events_list_seq_idx
  ON gear_list_events (list_id, seq);

-- Append-only for the app role: INSERT + SELECT only on events.
GRANT SELECT, INSERT ON gear_list_events TO crusaderstrike_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON gear_lists TO crusaderstrike_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON gear_list_items TO crusaderstrike_app;
GRANT ALL ON gear_list_events, gear_lists, gear_list_items TO crusaderstrike_migrate;

ALTER TABLE gear_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE gear_lists FORCE ROW LEVEL SECURITY;
ALTER TABLE gear_list_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE gear_list_items FORCE ROW LEVEL SECURITY;
ALTER TABLE gear_list_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE gear_list_events FORCE ROW LEVEL SECURITY;

-- Tenant isolation: when app.guild_id is set, only that guild's rows are visible.
-- When unset (migrate / tests as superuser with BYPASSRLS), policies still apply to
-- non-bypass roles; superuser bypasses RLS so existing tests keep working.
DROP POLICY IF EXISTS gear_lists_tenant ON gear_lists;
CREATE POLICY gear_lists_tenant ON gear_lists
  USING (guild_id = app_current_guild_id())
  WITH CHECK (guild_id = app_current_guild_id());

DROP POLICY IF EXISTS gear_list_items_tenant ON gear_list_items;
CREATE POLICY gear_list_items_tenant ON gear_list_items
  USING (guild_id = app_current_guild_id())
  WITH CHECK (guild_id = app_current_guild_id());

DROP POLICY IF EXISTS gear_list_events_tenant ON gear_list_events;
CREATE POLICY gear_list_events_tenant ON gear_list_events
  USING (guild_id = app_current_guild_id())
  WITH CHECK (guild_id = app_current_guild_id());

-- Allow the migrate/bootstrap role to SET ROLE crusaderstrike_app (tests + local).
DO $$
BEGIN
  EXECUTE format('GRANT crusaderstrike_app TO %I', current_user);
EXCEPTION WHEN insufficient_privilege OR invalid_grant_operation THEN
  NULL;
END
$$;
