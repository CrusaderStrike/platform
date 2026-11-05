# Auth contract (web-facing)

Language-agnostic notes for Web / Addon clients. OpenAPI (`openapi/v1.yaml`) is authoritative; this page calls out the parameters Web must know by name.

## Start Battle.net OAuth

`GET /api/v1/auth/blizzard/login`

| Query | Required | Notes |
|---|---|---|
| `return_to` | no | Same-origin **relative** path only. Must start with a single `/` after decoding once. No `//`, scheme/host, backslash, or encoded forms of those. Stored server-side with the OAuth state. Invalid or missing → `/profile/`. Login always `302`s to Battle.net (never `400` for a bad `return_to`). |

## OAuth callback

`GET /api/v1/auth/blizzard/callback`

- Always `302` back to the site.
- Redirect path is the **server-stored** `return_to` from login (looked up by `state`, then cleared — single-use).
- A `return_to` query on the callback is **ignored**.
- Missing / expired / invalid stored path → `/profile/`.
- `auth=ok|cancelled|error` (and `reason=…` on error) are appended as query params.

## Session cookie

`cs_session`: HttpOnly, Secure, SameSite=Lax, Path=/, no Domain, Max-Age 2592000.
