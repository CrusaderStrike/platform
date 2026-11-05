<p align="center"><img src="assets/logo.svg" alt="Crusader Strike logo" width="160"></p>

# crusaderstrike

Crusader Strike platform: backend holding every guild's data, serving the website, and handling recruiting and member profiles. **World of Warcraft Forever only.**

## API contract (v1 draft)

`openapi/v1.yaml` is the language-agnostic OpenAPI 3.1 contract. Lint with `npm run lint:openapi`.

## Stack (scaffold for #2 / #13)

- TypeScript / Node 20+
- Fastify
- Postgres 16 (plain SQL migrations, `node-postgres`)
- Vitest + embedded Postgres for tests
- Blizzard OAuth with PKCE; `BLIZZARD_MOCK` defaults to false (dev mock opt-in). Multi-region via `BLIZZARD_REGIONS` (us,eu,kr,tw); Forever namespace `profile-forever-{region}`

This repository's application scaffold lands with platform#11 so auth can ship. Architecture choice in #13 can still reshape the guild/event-sourcing layers.

## Quick start

```bash
cp .env.example .env
docker compose up -d db
npm install
npm run migrate
npm run dev
```

Or all-in-one: `docker compose up --build`.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | API with reload (`tsx watch`) |
| `npm run migrate` | Apply `migrations/*.sql` |
| `npm test` | Vitest (OAuth, CSRF, refresh, gear) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint:openapi` | Redocly lint |

## Migrations

Plain SQL files in `migrations/*.sql`, applied in name order by `npm run migrate` (and on API boot).
Each applied file is checksummed in `schema_migrations`. **Never edit a migration after it has been
applied** anywhere (prod, staging, or a shared dev DB) — add a new numbered file instead. The migrator
refuses to start if an applied file's contents drift.

## Auth endpoints (platform#11)

Addon data upload (platform#3) is `POST /api/v1/uploads`: session + CSRF; `characterId` or
`realm`+`name` must resolve to a selected main/alt; schemaVersion 1; dedupe by
`(character_id, addon_run_id|addon_pvp_id)` (guild not in the key). On re-upload, `guild_id`
always updates to the session's current upload guild for both dungeon runs and PvP.
Realm matching strips spaces/hyphens/apostrophes (case-insensitive) so addon
`GetNormalizedRealmName()` values match stored display names. Still-`in_progress` re-uploads
refresh bosses/deaths/payload while status only moves forward. Each record uses a SAVEPOINT so
one DB error does not poison the batch. Envelope is strict; unknown keys on records/stats are
soft-ignored. Whole-body limit is 1 MiB — clients split backlogs. World PvP and battlegrounds
from addon#15 are stored; BG stats keep `honorable_kills` only.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/auth/blizzard/login` | Starts OAuth; `return_to` relative path |
| GET | `/api/v1/auth/blizzard/callback` | Always 302 to site with `auth=` |
| GET | `/api/v1/auth/session` | Session + `csrf_token` |
| DELETE | `/api/v1/auth/session` | Logout (CSRF) |
| GET/PUT | `/api/v1/me/profile` | Profile; PUT is CSRF |
| GET | `/api/v1/me/characters` | Forever roster + selection |
| POST | `/api/v1/me/characters/refresh` | CSRF; 60s rate limit; 502 upstream |
| PUT | `/api/v1/me/characters/selection` | `{main_id, alt_ids}` CSRF |
| GET/PUT | `/api/v1/characters/{id}/gear` | Equipped set; `itemId` camelCase |
| POST | `/api/v1/uploads` | Batch dungeon runs + world PvP + BGs (CSRF; selected character; idempotent) |

## Ops

Nightly DB backups: see `docs/backups.md` and `ops/`.
