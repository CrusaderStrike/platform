-- platform#40: named armory gear sets (type / until_level / role_spec) + slot events.
-- Applied migrations are immutable — additive only.

ALTER TABLE gear_lists
  ADD COLUMN IF NOT EXISTS set_type TEXT NOT NULL DEFAULT 'max_level'
    CHECK (set_type IN ('leveling', 'max_level')),
  ADD COLUMN IF NOT EXISTS until_level INT
    CHECK (until_level IS NULL OR (until_level >= 1 AND until_level <= 60)),
  ADD COLUMN IF NOT EXISTS role_spec TEXT
    CHECK (role_spec IS NULL OR char_length(role_spec) <= 32);

-- Existing rows keep max_level / null until_level via DEFAULT.
UPDATE gear_lists
SET until_level = NULL
WHERE set_type = 'max_level' AND until_level IS NOT NULL;

ALTER TABLE gear_list_events DROP CONSTRAINT IF EXISTS gear_list_events_event_type_check;
ALTER TABLE gear_list_events ADD CONSTRAINT gear_list_events_event_type_check
  CHECK (event_type IN (
    'GearListCreated',
    'GearListRenamed',
    'GearListDeleted',
    'GearListMetaChanged',
    'GearItemAdded',
    'GearItemRemoved',
    'GearItemReprioritized',
    'GearItemObtained',
    'GearSlotSet',
    'GearSlotCleared',
    'GearOpRejected'
  ));
