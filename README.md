<p align="center"><img src="assets/logo.svg" alt="Crusader Strike logo" width="160"></p>

# crusaderstrike

Crusader Strike platform: backend holding every guild's data, serving the website, and handling recruiting and member profiles.

## API contract (v1 draft)

`openapi/v1.yaml` is the language-agnostic OpenAPI 3.1 contract for signups, Blizzard OAuth (placeholder, #11), guild profile, runs/rankings, event-sourced gear lists and addon sync (WoW Forever only). Guild scope always comes from the session, never the payload. Lint with `npx @redocly/cli lint openapi/v1.yaml`.
