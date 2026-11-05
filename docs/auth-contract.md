# Auth contract (web-facing)

Language-agnostic notes for Web / Addon clients. OpenAPI (`openapi/v1.yaml`) is authoritative; this page calls out the parameters Web must know by name.

## Start Battle.net OAuth

`GET /api/v1/auth/blizzard/login`

| Query | Required | Notes |
|---|---|---|
| `return_to` | no | Same-origin **relative** path only. Must start with a single `/` after decoding once. No `//`, scheme/host, backslash, or encoded forms of those. After that check, the path is resolved against the site origin and must stay on that origin (so values like `/.//evil` that collapse to a protocol-relative path are rejected). Soft-fallback: invalid or missing → `/profile/` (login still `302`s to Battle.net; never `400`). Stored server-side with the OAuth state. |
| `prompt` | no | Allow-list: `login` only (platform#76). Forwarded to Battle.net authorize. Missing/empty → omitted. Any other value → `400` with `{ errors: { prompt: invalid } }`. Use after `DELETE /auth/session` for switch-account. Blizzard may ignore `prompt` when a Battle.net cookie session already exists (not documented; forum reports 2020). |

### Pattern (accepted)

- Single leading `/`, then a path/query/hash on our site: `/profile/`, `/gear/`, `/gear/lists/?x=1#y`, `/@evil.com` (path segment, not userinfo — stays on crusaderstrike.com).

### Rejected (soft-fallback to `/profile/`)

- Absolute / off-site: `https://evil.example/`, `//evil.com`
- Backslash / encoded slash tricks: `/\evil`, `/%2F%2Fevil`, `/%5Cevil`, residual `%2F`/`%5C` after one decode
- Control / whitespace: `/\tevil`, `/%0d%0a…`
- Scheme-looking after the leading slash: `/https://…`, `/javascript:…`, and also **`/foo:bar`** (the scheme check is intentionally strict; colon paths are rejected)
- Origin escape after URL resolve: `/.//evil` (pathname becomes `//evil`)

## OAuth callback

`GET /api/v1/auth/blizzard/callback`

- Always `302` back to the site.
- Redirect path is the **server-stored** `return_to` from login (looked up by `state`, then cleared — single-use), re-validated with the same shared helper as start-auth.
- A `return_to` query on the callback is **ignored**.
- Missing / expired / invalid stored path → `/profile/`.
- `auth=ok|cancelled|error` (and `reason=…` on error) are appended as query params.

## Session cookie

`cs_session`: HttpOnly, Secure, SameSite=Lax, Path=/, no Domain, Max-Age 2592000.
