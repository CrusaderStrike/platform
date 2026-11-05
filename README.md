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

## Auth endpoints (platform#11)

Addon data upload (platform#3) is `POST /api/v1/uploads`: session + CSRF, `characterId` must be
selected main/alt, strict schemaVersion 1, dedupe by `addon_run_id` / `addon_pvp_id` per guild+character.
World PvP and battlegrounds from addon#15 are stored; BG stats keep `honorable_kills` only (no killing-blows).

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
