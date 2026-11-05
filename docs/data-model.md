# Crusader Strike data model (WoW Forever only)

Language-agnostic. Postgres 16. **World of Warcraft Forever only** — never Retail, Classic, or SoD namespaces.

This document covers the parts of platform#2 that platform#17 needs (guild stub + gear lists) plus the event-sourced gear wishlist model. Equipped gear (`character_gear`) and addon uploads (`dungeon_runs`, PvP tables) live in earlier migrations and are summarized here for tenancy context.

## Tenancy

- Every guild-scoped row carries `guild_id UUID NOT NULL`.
- The server derives `guild_id` from the session (active guild membership, else the user's personal guild). Any `guild_id` in a request body is ignored.
- Per request / transaction: `SET LOCAL app.guild_id = '<uuid>'`. Helper: `app_current_guild_id()`.
- Gear tables force RLS with policy `guild_id = app_current_guild_id()`.
- Production app connections should use role `crusaderstrike_app` (no BYPASSRLS). Role `crusaderstrike_migrate` is for schema changes.

### Guild stub (until #2 completes)

| Table | Purpose |
|---|---|
| `guilds` | `kind` = `personal` \| `guild`; personal guilds are unique per `owner_user_id` |
| `guild_members` | `(guild_id, user_id)` with role `owner` \| `officer` \| `member` |

### Characters (platform#11)

`characters` are keyed by opaque `id` text, owned by `user_id`. Gear wishlists are **per character** (max **5** active lists). Equipped gear is separate (`character_gear`).

## Gear wishlists (platform#17)

**Decision (platform#13 hybrid, clarified):** for gear lists the **event log is the source of truth**. Read tables `gear_lists` and `gear_list_items` are projections updated **in the same transaction** as each append (no async worker). Replaying the log for a list must rebuild an identical projection.

### `gear_list_events` (append-only)

| Column | Notes |
|---|---|
| `guild_id` | Tenant |
| `list_id` | Stream id |
| `seq` | Monotonic per `(guild_id, list_id)`, starts at 1 |
| `event_type` | See below |
| `schema_ver` | Payload schema version (start at 1) |
| `payload` | JSONB; shape depends on `event_type` |
| `source` | `web` \| `addon` \| `companion` \| `export` \| `system`. Sync path is agnostic: companion app and SavedVariables/export strings both POST the same op shape; `source` records which channel fed the op (`companion` vs `export`). Website edits use `web`. |
| `actor` | User id or opaque actor string |
| `idempotency_key` | Unique per guild; typically `op:<op_id>` or `create:<list_id>` |
| `occurred_at` | Client timestamp when known |
| `recorded_at` | Server time (last-writer-wins clock) |

**PK:** `(guild_id, list_id, seq)`  
**UNIQUE:** `(guild_id, idempotency_key)`  
**App role:** `INSERT` + `SELECT` only (no `UPDATE`/`DELETE`).

### Event types and payloads

| `event_type` | Payload |
|---|---|
| `GearListCreated` | `{ name, character_id, visibility? }` |
| `GearListRenamed` | `{ name }` |
| `GearListDeleted` | `{ }` |
| `GearItemAdded` | `{ slot, item_id, priority, note? }` |
| `GearItemRemoved` | `{ slot, item_id }` |
| `GearItemReprioritized` | `{ slot, item_id, priority }` |
| `GearItemObtained` | `{ slot, item_id, obtained: true\|false, run_id? }` (`obtained: false` = undo) |
| `GearOpRejected` | `{ op_id, reason, winning_seq?, message? }` |

`icon_url` is **not** part of wishlist item payloads. It stays `null` in API responses until Blizzard documents a Forever static item-media namespace (follow-up ticket).

### Read tables (projections)

**`gear_lists`:** `id`, `guild_id`, `character_id`, `owner_user_id`, `name`, `version` (= last applied `seq`), `visibility` (`private` \| `guild`), `deleted_at`, `updated_at`, `updated_source`, `updated_by`.

**`gear_list_items`:** PK `(list_id, slot, item_id)`; columns `guild_id`, `priority`, `note`, `obtained`, `obtained_at`.

**`gear_op_noop_ids`:** PK `(guild_id, idempotency_key)`; columns `list_id`, `recorded_at`. Markers for no-op `set_slot`/`clear_slot` (no event / no version bump). **Retention: 30 days** — see runbook § gear_op_noop_ids retention (platform#47).

Projection rule: every successful command appends one or more events and updates these tables in the **same** transaction. `GearOpRejected` appends to the log but does not change item rows (except as documented for conflict recording).

### Sharing and permissions (Drew)

- Lists are **private by default** (`visibility = private`).
- Owner may share with the guild (`visibility = guild`).
- Officers may **view** shared lists; they **never edit**. Server enforces.
- Max **5** active (non-deleted) lists per character; creating a 6th returns `400` `list_limit`.
- Looting a wished-for item may auto-mark obtained (client op `mark_obtained`); undo is `mark_obtained` with `obtained: false` (one-click undo).

### Conflict rules (Drew; no prompts)

Written into the OpenAPI `/sync` and `/gear-lists/{id}/ops` descriptions:

1. Auto-merge by `(slot, item_id)` — ops on different items always merge.
2. Last-writer-wins by server `recorded_at` when the same item conflicts.
3. A stale `base_version` loses (client must have based on current list version).
4. Delete wins over reprioritize / obtain on the same item.
5. Losing ops are recorded as `GearOpRejected` and returned to the client (not silent).

Optimistic-concurrency failures that cannot be merged return **409** with the shared error format.

### Sync path (platform#21 still open)

`POST /api/v1/sync` accepts the **same** envelope and op schema whether the caller is:

- a desktop **companion** (`source: companion`), or
- a website **export / SavedVariables paste** path (`source: export`).

Both send `characterId` **or** `realm` + `name` (realm normalized like uploads: strip spaces, hyphens, apostrophes; case-insensitive). Envelope is strict; unknown keys on individual ops are soft-ignored. Each op is applied under a **SAVEPOINT** with **stable reject codes** (never raw DB text).

### Tests specified

- Rebuild from the event log matches `gear_lists` / `gear_list_items`.
- Guild A cannot read or mutate guild B's lists (RLS + API).
- Re-sending an op with the same `idempotency_key` / `op_id` is a no-op (`duplicate`).


## Web Dev answers (platform#17 / web#18)

1. **Per character.** `GET/POST /api/v1/characters/{character_id}/gear-lists`. Max **5** active lists per character.
2. **PATCH/DELETE** `/api/v1/gear-lists/{id}` with `ETag: "v<version>"` and `If-Match`. Mismatch → **409** `version_mismatch` whose body includes `current: { version, list }`.
3. **Item ops** (`POST .../ops` and sync): always **200** with `conflicts[]` — never 409 for item merge. `base_version` is the list `version` the client last observed (from GET or the previous ops/sync response). Web sets `base_version` to that value for every op it sends.
4. **Undo obtained:** `mark_obtained` with `obtained: false` (same event type `GearItemObtained` with `obtained: false` in payload). No separate `unmark_obtained` op.
5. **History path:** `GET /api/v1/gear-lists/{id}/events` (not `/history`). Each `event_type` has a documented payload schema. `actor` is `{ user_id, display_name }` (BattleTag). Visibility follows the list: owner always; guild members when `visibility=guild`; everyone else **403** `forbidden`.
6. **`visibility`:** `private` | `guild`. Guild members may **read** shared lists; **only the owner writes**. Officer writes → **403** `forbidden`.
7. **6th list:** **409** `list_limit_reached`. Max **100** items per list. Max **priority** **50**. Non-Forever item ids → **422** `item_not_forever` (enforced once a Forever item index exists; until then positive integers are accepted and the code is reserved).
8. **Item search:** not in this PR. Plan: add `GET /api/v1/items/search?q=&slot=` when a Forever item catalog is available (follow-up after Blizzard Forever item data / local index). Until then web enters Forever item ids directly.
9. **GearList** includes `updated_source` and `updated_at`.
10. **Casing:** wishlist keeps **snake_case** `item_id` (and `list_id`, `base_version`, …) as already documented beside equipped gear's camelCase `itemId`. Equipped gear is unchanged.

## Named armory gear sets (platform#40 / #41)

- Create/list are character-scoped under `/api/v1/characters/{id}/gear-lists` (cap **20**).
- Display set replaces main/alt: `PATCH /me/characters/{id}` `{displayed}` (primary) or
  `PUT /me/characters/selection` `{displayed_character_ids}`. New characters default
  `displayed: false`. Gear create/list/writes require a displayed character → **409**
  `character_not_displayed`; ownership **404** is checked first.
- Per-slot PUT `/gear-lists/{id}/slots/{slot}`: **If-Match optional** (omit → last-write-wins).
  No-op set/clear returns **200** with current state and does not bump `version`.
  Slot/item errors are **400** `validation_error` with field details
  (`slot: invalid_slot`, `item_id: item_not_in_slot` / `item_not_forever`).
- Events: `GearListMetaChanged`, `GearSlotSet`, `GearSlotCleared` (see event table above when present).
