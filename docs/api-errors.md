# API error envelope (platform#51)

Scope for this pass: **gear-lists** (including `/ops` and `/sync`), **selection** (`/api/v1/me/characters/selection` and related character list/refresh used by display-set flows), and **items**. Guild/loot routes are unchanged.

## Envelope

Non-field errors:

```json
{
  "error": {
    "code": "<stable_code>",
    "message": "Human-readable, safe to show.",
    "retryable": false,
    "request_id": "req_…"
  }
}
```

- **`code`** — stable string; Web and Addon already parse these reason codes — **do not rename**.
- **`retryable`** — whether a blind retry (after `Retry-After` / backoff) may succeed without changing the request.
- **`request_id`** — correlation id (also the Fastify request id).
- **Never** included: stack traces, upstream response bodies, tokens, cookies, or other secrets.

Field validation (unchanged, backward compatible):

```json
{ "errors": { "<field>": "<reason>" } }
```

Some conflict responses (e.g. gear-list `version_mismatch`) also include a `current` payload beside `error`.

When known, rate limits and upstream outages set the **`Retry-After`** response header (seconds).

## Code table

| code | HTTP | retryable | When |
|------|------|-----------|------|
| `unauthenticated` | 401 | no | No `cs_session` cookie (caller must sign in). |
| `session_expired` | 401 | no | Cookie present but session expired/revoked/unknown, or stored Blizzard token invalid/unauthorized (caller must clear session and sign in again). |
| `csrf_failed` | 403 | no | Missing/mismatched `X-CSRF-Token` on a mutating cookie request. |
| `validation_error` | 400 | no | Body/query failed validation (`errors` field map when present). |
| `not_found` | 404 | no | Resource not visible / does not exist. |
| `forbidden` | 403 | no | Authenticated but not allowed. |
| `rate_limited` | 429 | **yes** | Rate limit exceeded; honor `Retry-After`. |
| `version_mismatch` | 409 | **yes** | Optimistic concurrency failure; reload and retry. |
| `character_not_displayed` | 409 | no | Character not in the display set. |
| `list_limit_reached` | 409 | no | Max gear lists per character (20). |
| `precondition_required` | 428 | no | `If-Match` required. |
| `upstream_unavailable` | 502/503 | **yes** | Battle.net (or other upstream) 5xx/timeout; `Retry-After` when known. |
| `payload_too_large` | 413 | no | Body exceeds size limit. |
| `unsupported_media_type` | 415 | no | Content-Type must be `application/json`. |
| `internal_error` | 500 | **yes** | Unexpected server failure (no details leaked). |

Items catalog routes are public (no session). Gear-lists and selection require a session; they emit `unauthenticated` / `session_expired` as above. Selection refresh is the scoped path that may emit `upstream_unavailable` or `session_expired` from Blizzard token failures.

See also `openapi/v1.yaml` → `components.schemas.Error` and `x-error-codes`.
