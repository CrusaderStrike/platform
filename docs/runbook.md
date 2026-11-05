# CrusaderStrike Platform Runbook (crusaderstrike-platform-1)
No secrets live in this file. Keys and tokens are in the operator vault or under /home/box/.config/do-platform/ on the agent box.

## Architecture
- DigitalOcean droplet `crusaderstrike-platform-1` (id 616006981), region sfo3, size s-1vcpu-2gb (1 vCPU, 2 GB RAM, 50 GB disk, 2 GB swap), Ubuntu 24.04.5 LTS, public IP 24.199.127.192.
- Stack in `/opt/crusaderstrike`:
  - `docker-compose.yml` (droplet production file, not the repo's local-dev compose): postgres:16 (container `crusaderstrike-postgres-1`), bound to 127.0.0.1:5432 only. Mounts `./initdb:/docker-entrypoint-initdb.d:ro`. The idempotent roles script lives in this repo at `initdb/01-roles.sh` and is copied to `/opt/crusaderstrike/initdb/01-roles.sh` on the droplet.
  - `docker-compose.caddy.yml` and `caddy/Caddyfile`: caddy:2 (container `crusaderstrike-caddy-1`) on ports 80 and 443 (TCP and UDP/HTTP3). It handles TLS automatically.
- Public endpoint: https://api.crusaderstrike.com/healthz should return 200.
- What lives where: the website (static SPA) is on **GitHub Pages** from [CrusaderStrike/web](https://github.com/CrusaderStrike/web). The API and data are on this droplet. Never SSH to the droplet to change site content.

### DNS map
DNS is hosted at Lithium (`ns1.lithiumdns.net`, `ns2.lithiumdns.net`).

| Name | Record | Target | TLS |
|---|---|---|---|
| `crusaderstrike.com` (apex) | A ×4 (+ AAAA) | GitHub Pages `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` (AAAA `2606:50c0:8000::153`–`8003::153`) | GitHub Pages |
| `www.crusaderstrike.com` | CNAME | `crusaderstrike.github.io` | GitHub Pages |
| `api.crusaderstrike.com` | A | `24.199.127.192` (droplet) | Caddy / Let's Encrypt on the droplet |

Check with: `dig +short crusaderstrike.com A`, `dig +short www.crusaderstrike.com CNAME`, `dig +short api.crusaderstrike.com A`.

### API CORS
- **The Fastify app owns CORS.** `@fastify/cors` in `src/app.ts` reflects allowlisted origins from `CORS_ORIGINS` (`https://crusaderstrike.com`, `https://www.crusaderstrike.com`), sets `Access-Control-Allow-Credentials: true`, methods `GET, POST, PUT, PATCH, DELETE, OPTIONS`, headers `Content-Type, X-CSRF-Token, If-Match, Authorization`, and `Access-Control-Expose-Headers: Retry-After` (so credentialed browser JS can read the 429 countdown on `POST /api/v1/me/characters/refresh`). Preflight `OPTIONS` is handled by the app.
- **Do not set any `Access-Control-*` (or CORS preflight short-circuit) in `caddy/Caddyfile`.** Caddy only terminates TLS and reverse-proxies to `api:3000`. If both layers emit CORS headers, browsers see duplicates (e.g. two `Access-Control-Allow-Origin` values) and reject every credentialed call from the site.
- Check (each Access-Control header must appear **exactly once**):
  ```
  # Expect count 1 for each:
  curl -sI -H 'Origin: https://crusaderstrike.com' https://api.crusaderstrike.com/healthz | grep -ci '^access-control-allow-origin:'
  curl -sI -H 'Origin: https://www.crusaderstrike.com' https://api.crusaderstrike.com/api/v1/auth/session | grep -ci '^access-control-allow-origin:'
  curl -sI -H 'Origin: https://crusaderstrike.com' https://api.crusaderstrike.com/healthz | grep -ci '^access-control-expose-headers:'
  # Expect allow-credentials true, expose Retry-After, ACAO equals Origin:
  curl -sI -H 'Origin: https://crusaderstrike.com' https://api.crusaderstrike.com/healthz | grep -i access-control
  curl -si -X OPTIONS -H 'Origin: https://www.crusaderstrike.com' -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: Content-Type, X-CSRF-Token' https://api.crusaderstrike.com/api/v1/auth/session | head -20
  ```
  An unlisted origin must get no `Access-Control-Allow-Origin`. Duplicate counts (2+) mean Caddy is still injecting CORS — remove those directives and reload.
- Agents running: DO metrics agent (`do-agent`) and `droplet-agent` are both active.

## Access
- SSH: `ssh -i <platform key> root@24.199.127.192`. All commands in this runbook assume `root` (key-only; root login stays enabled with `prohibit-password`, password auth is off). The `deploy` user is key-only and reserved for a future CI deploy.
- DO API: a scoped token used by the Platform Dev agent. Never print it or commit it.

## Website (GitHub Pages)
- Source: [CrusaderStrike/web](https://github.com/CrusaderStrike/web), workflow `.github/workflows/deploy-pages.yml` ("Deploy to GitHub Pages"), runs on every push to `main` and on `workflow_dispatch`. Custom domain (CNAME) `crusaderstrike.com`, HTTPS enforced.
- Deploy: merge the PR (or push) to `web` `main`. Watch Actions until "Deploy to GitHub Pages" succeeds, then check `curl -fsSI https://crusaderstrike.com` and `curl -fsSI https://www.crusaderstrike.com`.
- Rollback: `git revert <bad sha>` on `main` and push (or run the workflow via `workflow_dispatch` on a known-good SHA). Confirm the Pages deployment finished and the site serves the old version. Do **not** touch the droplet for site content.
- www TLS: the Pages certificate must cover both `crusaderstrike.com` and `www.crusaderstrike.com` (www redirects to apex). If www TLS breaks (cert lists only the apex), re-set the Pages custom domain in web → Settings → Pages: clear it, save, set `crusaderstrike.com` again and save. That re-issues the cert including www. Wait for "Certificate provisioned", then re-enable "Enforce HTTPS". Confirm the www CNAME still points to `crusaderstrike.github.io`.


## API service (first deploy and updates)

Production compose fragment: `ops/docker-compose.api.yml` (copied to `/opt/crusaderstrike/docker-compose.api.yml` on the droplet). Image builds from a checkout of this repo at `/opt/crusaderstrike/platform`. Before every `build api` / `up -d api` (because `src/index.ts` runs `migrate()` on boot), append `platform_HEAD` and the current API image id to `/root/image-digests.log`, and tag the running image `crusaderstrike-api:prev` **and** `crusaderstrike-api:prev-<shortsha>` for rollback.

### First deploy
1. Ensure DNS `api.crusaderstrike.com` A → `24.199.127.192` (verify with `dig @8.8.8.8` or dns.google; the operator box resolver may lie).
2. Checkout platform `main` onto the droplet at `/opt/crusaderstrike/platform`.
3. Copy `ops/docker-compose.api.yml` to `/opt/crusaderstrike/docker-compose.api.yml`.
4. **Postgres roles** (required before the API can migrate).

   Source of truth for the script: repo `initdb/01-roles.sh` (idempotent). On the droplet:

   ```
   install -d -m 0755 /opt/crusaderstrike/initdb
   cp -a /opt/crusaderstrike/platform/initdb/01-roles.sh /opt/crusaderstrike/initdb/01-roles.sh
   chmod 0755 /opt/crusaderstrike/initdb/01-roles.sh
   ```

   Production `docker-compose.yml` must mount it for **fresh** volumes:

   ```
   volumes:
     - pgdata:/var/lib/postgresql/data
     - ./initdb:/docker-entrypoint-initdb.d:ro
   ```

   and the postgres service must receive `MIGRATE_PASSWORD` / `APP_PASSWORD` from `/opt/crusaderstrike/.env` (alongside `POSTGRES_PASSWORD` for the superuser). **Never put the superuser password in `api.env`.**

   **Persist role passwords first (append-only; never re-mint if already present):**

   ```
   cd /opt/crusaderstrike
   [ -e .env ] || install -m 0600 /dev/null .env
   # Mint only when missing — re-minting would desync .env from the live role.
   if ! grep -q '^MIGRATE_PASSWORD=' .env; then
     printf 'MIGRATE_PASSWORD=%s\n' "$(openssl rand -hex 24)" >> .env
   fi
   if ! grep -q '^APP_PASSWORD=' .env; then
     printf 'APP_PASSWORD=%s\n' "$(openssl rand -hex 24)" >> .env
   fi
   chmod 0600 .env
   ```

   **Load passwords into the environment without printing, then run the script:**

   ```
   set -a
   # shellcheck disable=SC1091
   source <(grep -E '^(MIGRATE_PASSWORD|APP_PASSWORD)=' .env)
   set +a
   docker exec -i -e MIGRATE_PASSWORD -e APP_PASSWORD \
     crusaderstrike-postgres-1 bash -s < /opt/crusaderstrike/initdb/01-roles.sh
   # Expect stdout: roles_ok crusaderstrike_migrate crusaderstrike_app
   unset MIGRATE_PASSWORD APP_PASSWORD
   ```

   Fresh-volume path: the same script runs automatically via `/docker-entrypoint-initdb.d` on first Postgres init (passwords already in `.env` / compose env). Re-running the `docker exec` form on an existing DB is safe: it creates roles if missing, syncs passwords from `.env`, and re-applies ownership/grants.

   Confirm without secrets:

   ```
   docker exec crusaderstrike-postgres-1 psql -U postgres -d crusaderstrike -tAc \
     "SELECT rolname FROM pg_roles WHERE rolname LIKE 'crusaderstrike%'"
   ```

   Expect `crusaderstrike_migrate` and `crusaderstrike_app`.

5. **`/opt/crusaderstrike/api.env` (root, mode 0600) — never overwrite.**

   - Create only if absent: `[ -e /opt/crusaderstrike/api.env ] || install -m 0600 /dev/null /opt/crusaderstrike/api.env`
   - After that, **only append (`>>`) or edit a single line in place**. Never `>` redirect, never `cp` / re-copy a template over a live file. Overwriting can rotate `SESSION_SECRET` or lose `TOKEN_ENC_KEY` (stored Blizzard tokens become unreadable).
   - Key rotation uses `TOKEN_ENC_KEY_PREVIOUS` (see TOKEN_ENC_KEY rotation) — do not replace `TOKEN_ENC_KEY` with `>`.
   - If you must snapshot before an in-place line edit: `cp -p api.env api.env.$(date -u +%Y%m%dT%H%M%SZ).bak && chmod 0600 api.env.*.bak`. Keep `.bak` copies **root-only mode 0600**, never ship them off-box unless the destination is encrypted, and **delete them once the change is verified**.
   - Append each key only if absent (examples):

     ```
     cd /opt/crusaderstrike
     append_kv() { # usage: append_kv FILE KEY VALUE  (VALUE must already be safe/trimmed)
       local f="$1" k="$2" v="$3"
       grep -q "^${k}=" "$f" 2>/dev/null || printf '%s=%s\n' "$k" "$v" >> "$f"
     }
     append_kv api.env NODE_ENV production
     append_kv api.env PORT 3000
     append_kv api.env PUBLIC_WEB_ORIGIN https://crusaderstrike.com
     append_kv api.env PUBLIC_API_ORIGIN https://api.crusaderstrike.com
     append_kv api.env CORS_ORIGINS https://crusaderstrike.com,https://www.crusaderstrike.com
     append_kv api.env BLIZZARD_MOCK false
     append_kv api.env BLIZZARD_REGIONS us
     append_kv api.env BLIZZARD_REDIRECT_URI \
       https://api.crusaderstrike.com/api/v1/auth/blizzard/callback

     # DATABASE_URL — only if absent; load migrate password without printing:
     if ! grep -q '^DATABASE_URL=' api.env; then
       set -a
       source <(grep -E '^MIGRATE_PASSWORD=' .env)
       set +a
       printf 'DATABASE_URL=postgres://crusaderstrike_migrate:%s@postgres:5432/crusaderstrike\n' \
         "$MIGRATE_PASSWORD" >> api.env
       unset MIGRATE_PASSWORD
     fi

     # SESSION_SECRET / TOKEN_ENC_KEY — mint once:
     if ! grep -q '^SESSION_SECRET=' api.env; then
       printf 'SESSION_SECRET=%s\n' "$(openssl rand -hex 32)" >> api.env
     fi
     if ! grep -q '^TOKEN_ENC_KEY=' api.env; then
       printf 'TOKEN_ENC_KEY=%s\n' "$(openssl rand -hex 32)" >> api.env
     fi
     chmod 0600 api.env
     ```

   - **Blizzard client env-loader hardening:** when copying vault `blizzard_api` values into `api.env`, trim whitespace and trailing commas before append (a trailing comma breaks OAuth — Location shows `client_id=…%2C`):

     ```
     # Given raw values in shell vars from the stdin vault pipe (never echo them):
     trim_comma() { printf '%s' "$1" | tr -d '[:space:]' | sed 's/,*$//'; }
     BID=$(trim_comma "$RAW_BLIZZARD_CLIENT_ID")
     BSEC=$(trim_comma "$RAW_BLIZZARD_CLIENT_SECRET")
     # length check without printing: client id must be 32 hex chars
     [ ${#BID} -eq 32 ] || { echo "BLIZZARD_CLIENT_ID length != 32" >&2; exit 1; }
     append_kv api.env BLIZZARD_CLIENT_ID "$BID"
     append_kv api.env BLIZZARD_CLIENT_SECRET "$BSEC"
     unset RAW_BLIZZARD_CLIENT_ID RAW_BLIZZARD_CLIENT_SECRET BID BSEC
     ```

   Stream vault secrets **drewnix → box → droplet ssh stdin** only. Do not land secrets on the box disk or in argv; the droplet must never reach drewnix.

6. **Pre-build / pre-`up` Postgres backup + pin current image** (required before every `build api` or `up -d api`, because boot runs `migrate()` and migrations are **forward-only** with no down scripts). Do this **before** `git pull` / checkout of a new SHA so the tag matches the image that is actually running:

   ```
   /usr/local/bin/crusaderstrike-backup
   mkdir -p /root
   # SHA the RUNNING image was built from = last post-deploy (else last) platform_HEAD.
   # Do NOT use the SHA you are about to deploy.
   RUNNING_SHORT=$(awk '
     /^platform_HEAD / { sha=$2 }
     /post-deploy/ { post=1; post_sha="" }
     post && /^platform_HEAD / { post_sha=$2 }
     END {
       s = (post_sha != "" ? post_sha : sha)
       if (s != "") print substr(s,1,7)
     }
   ' /root/image-digests.log 2>/dev/null || true)
   {
     echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) pre-build"
     echo -n "running_platform_HEAD_short "; echo "${RUNNING_SHORT:-(none)}"
     docker inspect --format 'api_image={{.Config.Image}} api_id={{.Image}}' crusaderstrike-api-1 2>/dev/null || echo "api_image=(none yet)"
     docker inspect --format 'postgres_image={{.Config.Image}} postgres_id={{.Image}}' crusaderstrike-postgres-1
     docker inspect --format 'caddy_image={{.Config.Image}} caddy_id={{.Image}}' crusaderstrike-caddy-1
   } >> /root/image-digests.log
   # Tag the currently running API image for rollback (skip if first deploy / no image yet):
   if docker image inspect crusaderstrike-api:local >/dev/null 2>&1; then
     docker tag crusaderstrike-api:local crusaderstrike-api:prev
     if [ -n "$RUNNING_SHORT" ]; then
       docker tag crusaderstrike-api:local "crusaderstrike-api:prev-${RUNNING_SHORT}"
     fi
   fi
   # Now you may pull/checkout the new platform SHA and build.
   ```
   Ordering: **backup → tag running image as `:prev` / `:prev-<running-shortsha>` → pull/checkout → build → `up -d api`**. Never `up -d api` before the backup; that would apply pending migrations with no restore point. Migrations must stay **additive / backward-compatible** so `crusaderstrike-api:prev` / `prev-<sha>` can still run against the new schema. If a migration is not backward-compatible, rolling back code requires a Bot-approved restore from that backup (`docs/backups.md`) before serving old code.
7. Caddyfile: reverse-proxy `/healthz` and `/` to `api:3000`. **No CORS / `Access-Control-*` directives** (the app owns CORS; see Architecture). Back up first, but **do not reload Caddy yet** — start the API first so the proxy target is healthy:
   `cp -p caddy/Caddyfile caddy/Caddyfile.$(date -u +%Y%m%dT%H%M%SZ).bak`
8. Build & start the API **before** pointing Caddy at it:
   ```
   cd /opt/crusaderstrike
   docker compose -f docker-compose.yml -f docker-compose.caddy.yml -f docker-compose.api.yml build api
   docker compose -f docker-compose.yml -f docker-compose.caddy.yml -f docker-compose.api.yml up -d api
   # Wait until healthy:
   docker inspect -f '{{.State.Health.Status}}' crusaderstrike-api-1   # expect healthy
   ```
9. Point Caddy at the API (edit if needed), validate, reload once:
   ```
   docker exec crusaderstrike-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   docker exec crusaderstrike-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
   ```
10. After a successful deploy, append the new pin:
   ```
   {
     echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) post-deploy"
     echo -n "platform_HEAD "; git -C /opt/crusaderstrike/platform rev-parse HEAD
     docker inspect --format 'api_image={{.Config.Image}} api_id={{.Image}}' crusaderstrike-api-1
   } >> /root/image-digests.log
   ```
11. Smoke:
   - `curl -fsS https://api.crusaderstrike.com/healthz` → 200 `{"ok":true}`
   - Login Location smoke (client_id must be 32 chars and must not contain a comma / `%2C`):
     ```
     loc=$(curl -sS -D - -o /dev/null https://api.crusaderstrike.com/api/v1/auth/blizzard/login \
       | awk -F': ' 'tolower($1)=="location"{print $2}' | tr -d '\r')
     LOC="$loc" python3 -c 'from urllib.parse import urlparse,parse_qs; import os; q=parse_qs(urlparse(os.environ["LOC"]).query); cid=q.get("client_id",[""])[0]; assert "oauth.battle.net" in os.environ["LOC"]; assert len(cid)==32 and "," not in cid and "%2C" not in cid, (len(cid), "," in cid); assert q.get("code_challenge_method",[""])[0]=="S256"; print("login_smoke_ok")'
     ```
     Expect `login_smoke_ok`. Do not print `client_id`.
   - `GET /api/v1/auth/session` with no cookie → **401**.
   - CORS single-header check (Architecture): `grep -ci '^access-control-allow-origin:'` → **1** for both apex and www Origins; `allow-credentials: true`; `expose-headers` includes `Retry-After`.
   - Preflight: `OPTIONS` with allowed Origin → 204 and the same single CORS set (includes credentials).
   - Cookie flags (after a real callback in a private window, or from captured `Set-Cookie`): `cs_session` must be `Secure; HttpOnly; SameSite=Lax` and must **not** set `Domain=` (host-only on `api.crusaderstrike.com`).
   - Throwaway mock refusal (must not reach Postgres / run migrations). Full command:
     ```
     docker run --rm --network none --env-file api.env \
       -e BLIZZARD_MOCK=true -e NODE_ENV=production \
       --entrypoint node crusaderstrike-api:local \
       -e "require('./dist/config.js');"
     ```
     Expect non-zero exit / refuse production+mock. Do not boot `src/index.ts`. `--network none` ensures no DB even if config load were wrong.
   - 429 from `POST /api/v1/me/characters/refresh` (when rate-limited) includes `Retry-After` and CORS exposes it (header appears once).
   - `docker logs crusaderstrike-api-1` must not contain secrets.
12. Confirm backup crons still present: `/etc/cron.d/crusaderstrike-backup`, `/etc/cron.d/crusaderstrike-offsite-backup`.

### Restart / rebuild API only
Always run First deploy step 6 (backup + `/root/image-digests.log` pin + `docker tag …:prev` / `:prev-<shortsha>`) **before** `build` / `up -d api`. `migrate()` runs on every boot; skipping the backup means a bad migration has no restore point.
```
cd /opt/crusaderstrike
# step 6 (backup + pin + tag) goes HERE first
docker compose -f docker-compose.yml -f docker-compose.caddy.yml -f docker-compose.api.yml build api
docker compose -f docker-compose.yml -f docker-compose.caddy.yml -f docker-compose.api.yml up -d api
# wait healthy, then smoke /healthz + CORS single-header check
curl -fsS https://api.crusaderstrike.com/healthz
```

### API rollback
1. Prefer image rollback when the schema is still backward-compatible with the old code:
   ```
   # either the moving tag…
   docker tag crusaderstrike-api:prev crusaderstrike-api:local
   # …or a SHA-qualified tag from the pre-build step:
   # docker tag crusaderstrike-api:prev-<shortsha> crusaderstrike-api:local
   cd /opt/crusaderstrike
   docker compose -f docker-compose.yml -f docker-compose.caddy.yml -f docker-compose.api.yml up -d api
   docker inspect -f '{{.State.Health.Status}}' crusaderstrike-api-1   # expect healthy
   curl -fsS https://api.crusaderstrike.com/healthz
   ```
   Or check out the previous `platform_HEAD` from `/root/image-digests.log` under `/opt/crusaderstrike/platform`, then `build api` + `up -d api` + healthz (still take a backup first if this rebuild can migrate).
2. Migrations are forward-only (no down scripts). If the new migration is **not** backward-compatible with old code, do **not** only retag `:prev`. Stop writers, restore the pre-build dump through `docs/backups.md` (**Bot approval required**), then bring up the old image/SHA.
3. **Applied migrations are immutable.** Never edit a `migrations/*.sql` file after it has been applied. `migrate()` stores a SHA-256 of each applied file in `schema_migrations.checksum` and aborts boot on mismatch. Ship schema changes as a new numbered file. (Editing `006` in place during #34 review was only safe because it had not been applied in prod yet.)

### Env file location
`/opt/crusaderstrike/api.env` (root, 0600). **Never overwrite** — create with `install -m 0600` only when absent; afterward append (`>>`) or edit one line. Postgres **superuser** password stays in `/opt/crusaderstrike/.env` only; `api.env` may hold the migrate role password inside `DATABASE_URL`. Do not merge the files. Any `api.env.*.bak` snapshot must stay root-only `0600`, must not go to unencrypted offsite backup paths, and must be deleted once the change is verified.

## Deploy and restart (API droplet)
Before pulling or rebuilding anything that can touch Postgres (including an API rebuild — `migrate()` runs on boot), take a fresh backup and tag the **currently running** API image (same rule as First deploy step 6 — use the last post-deploy `platform_HEAD`, not the SHA you are about to check out):
```
/usr/local/bin/crusaderstrike-backup
RUNNING_SHORT=$(awk '
  /^platform_HEAD / { sha=$2 }
  /post-deploy/ { post=1; post_sha="" }
  post && /^platform_HEAD / { post_sha=$2 }
  END {
    s = (post_sha != "" ? post_sha : sha)
    if (s != "") print substr(s,1,7)
  }
' /root/image-digests.log 2>/dev/null || true)
{
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) pre-change"
  echo -n "running_platform_HEAD_short "; echo "${RUNNING_SHORT:-(none)}"
  docker inspect --format '{{.Name}} image={{.Config.Image}} id={{.Image}}' crusaderstrike-postgres-1 crusaderstrike-caddy-1 crusaderstrike-api-1 2>/dev/null
} >> /root/image-digests.log
docker tag crusaderstrike-api:local crusaderstrike-api:prev 2>/dev/null || true
[ -n "$RUNNING_SHORT" ] && docker tag crusaderstrike-api:local "crusaderstrike-api:prev-${RUNNING_SHORT}" 2>/dev/null || true
```
```
cd /opt/crusaderstrike
docker compose -f docker-compose.yml -f docker-compose.caddy.yml -f docker-compose.api.yml ps
docker compose -f docker-compose.yml -f docker-compose.caddy.yml -f docker-compose.api.yml pull
docker compose -f docker-compose.yml -f docker-compose.caddy.yml -f docker-compose.api.yml up -d
docker compose -f docker-compose.yml -f docker-compose.caddy.yml -f docker-compose.api.yml restart caddy        # or postgres / api
docker compose -f docker-compose.yml -f docker-compose.caddy.yml -f docker-compose.api.yml logs --tail=200 caddy
```
After any change, check that `curl -fsS https://api.crusaderstrike.com/healthz` returns 200 and the CORS **single-header** check under Architecture still passes.

Rollback (Caddy/Postgres base images): pin the image in the compose file to the previous digest from `/root/image-digests.log` (e.g. `image: caddy@sha256:...`) and `up -d` again. Rollback (API): see **API rollback** above (`:prev` tag or previous SHA).

Caddyfile changes: back up first (`cp -p caddy/Caddyfile caddy/Caddyfile.$(date -u +%Y%m%dT%H%M%SZ).bak`), edit (**no CORS headers**), validate, then `docker exec crusaderstrike-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`. To roll back, copy the backup over, validate, and reload.

## Backups
- Cron: `/etc/cron.d/crusaderstrike-backup` runs `0 3 * * * root /usr/local/bin/crusaderstrike-backup` and logs to `/var/log/crusaderstrike-backup.log`. Times are UTC (7 PM PST or 8 PM PDT).
- Output: `/var/backups/crusaderstrike/crusaderstrike-YYYY-MM-DD_HHMM.dump` (`pg_dump -U postgres -Fc crusaderstrike`, custom format, mode 0600). Database `crusaderstrike`, superuser `postgres`; the password is in `/opt/crusaderstrike/.env` and is never copied out. The last 7 days are kept.
- Off-site copies are not set up yet. That waits on [#8](https://github.com/CrusaderStrike/platform/issues/8) (Spaces bucket and key).
- Verify: `ls -la /var/backups/crusaderstrike` and `tail /var/log/crusaderstrike-backup.log`.

### Restore
1. Get approval through Bot first, because a restore overwrites data.
2. Stop writers: `cd /opt/crusaderstrike && docker compose -f docker-compose.yml -f docker-compose.caddy.yml -f docker-compose.api.yml stop api caddy`.
3. Copy the dump into the container: `docker cp /var/backups/crusaderstrike/<file>.dump crusaderstrike-postgres-1:/tmp/r.dump`
4. Restore: `docker exec crusaderstrike-postgres-1 pg_restore -U postgres -d crusaderstrike --clean --if-exists /tmp/r.dump`
5. Start api + caddy again (`up -d api caddy`), wait until api is healthy, and check /healthz. Then spot-check the row counts.
6. Test this procedure at least once a month in a scratch database:
   ```
   docker exec crusaderstrike-postgres-1 createdb -U postgres restore_test
   docker exec crusaderstrike-postgres-1 pg_restore -U postgres -d restore_test /tmp/r.dump
   docker exec crusaderstrike-postgres-1 psql -U postgres -d restore_test -c '\dt'   # spot-check tables and row counts
   docker exec crusaderstrike-postgres-1 dropdb -U postgres restore_test
   ```
   Log the date and result in `/var/log/crusaderstrike-restore-test.log`.

## TLS
- The **site** (apex and www) uses GitHub Pages certificates; see Website above. This section covers **api** only.
- Caddy gets and renews Let's Encrypt certificates automatically. Renewal starts about 30 days before expiry.
- Check expiry with: `echo | openssl s_client -connect api.crusaderstrike.com:443 -servername api.crusaderstrike.com 2>/dev/null | openssl x509 -noout -enddate`
- If renewal fails: confirm DNS still points to 24.199.127.192, that ports 80 and 443 are open, and read `docker compose logs caddy`.

## Firewall
- DO cloud firewall `crusaderstrike-platform-fw` allows inbound 22, 80 and 443 only.
- ufw on the host is active and allows 22, 80 and 443 (IPv4 and IPv6).
- Postgres is never exposed publicly (127.0.0.1 only). Any firewall change needs approval through Bot.

## Logs
- API: `docker compose -f docker-compose.yml -f docker-compose.caddy.yml -f docker-compose.api.yml logs api` (or `docker logs crusaderstrike-api-1`)
- Caddy: `docker compose -f docker-compose.yml -f docker-compose.caddy.yml logs caddy`
- Postgres: `docker compose logs postgres`
- Backups: `/var/log/crusaderstrike-backup.log`
- System: `journalctl -u docker`, `journalctl -u do-agent`, `/var/log/syslog`

## Monitoring (DigitalOcean, $0/month)
- do-agent is installed and active (Monitoring is free: https://docs.digitalocean.com/products/monitoring/details/pricing/).
- Uptime check `227c7160-ea24-47b8-b5d2-a56630c25dd3` on https://crusaderstrike.com from us_west and us_east. This is the account's one free check (https://docs.digitalocean.com/products/uptime/details/pricing/). **Never create a second one; each extra check costs $1/month.** It is on the site because the site is what users hit first. API liveness (`/healthz`) is checked manually with `curl` until a second check is budgeted through Bot.
- Alerts, all sent to the DO account's verified login email (a team member, so no invite or cost):
  - Droplet 616006981 policies, each over a 5-minute window: CPU >80% `0501a01d-4a88-4480-9892-6801ec55adc9`, memory >90% `8daf279b-fd42-472a-b5b1-77383f73b49d`, disk >80% `fd1665cd-e620-4dd7-9bd7-7c66c02a04d7`.
  - Uptime check alerts: down `cfd25c0c-a302-4609-8cf8-ba92566668e1`, latency >2000 ms `a3d7de56-9cf7-4352-9610-202d9043af10`, TLS certificate expiry within 14 days `12e14577-c4c9-44f3-970b-8ddfa5228422`.
  - Operators watch the DO account's verified login email inbox for these alerts.
  - Fire test (2026-11-04): CPU threshold temporarily lowered to 1% (droplet CPU ~2%), then restored to 80%.

## Incident checklist
1. Check /healthz and https://crusaderstrike.com.
2. Run `docker ps` and look at the DO graphs.
3. Look up the symptom in the table below.
4. Fix it, then verify.
5. Report to Bot with the timeline.

## Common incidents
| Symptom | Check | Fix |
|---|---|---|
| Disk full | `df -h /`, `du -sh /var/lib/docker /var/backups/* /var/log` | `docker system prune` (removes stopped containers, unused networks and dangling images; **never** add `--volumes`), `journalctl --vacuum-size=200M`, trim old logs or dumps, check that backup rotation works. |
| Postgres down | `docker ps`, `docker compose logs postgres`, healthcheck | `docker compose up -d postgres`. If the volume is corrupt, restore from backup (with approval). |
| Caddy or cert error | `/healthz` fails, cert date, `logs caddy` | Restart caddy. Check DNS and ports 80 and 443. Watch for Let's Encrypt rate limits. |
| High CPU or memory | `top`, `docker stats`, DO graphs | Find the busy container and restart it. If it keeps happening, propose a resize (paid) through Bot. |
| Site up on apex, www TLS/DNS broken | `curl -vI https://www.crusaderstrike.com`, `dig www.crusaderstrike.com CNAME` | Make sure www is a CNAME to `crusaderstrike.github.io`, then re-set the Pages custom domain to re-issue the cert (see Website). |
| Browser CORS error from the site | CORS check under Architecture (`grep -ci` ACAO → 1) | Confirm the **app** allowlist (`CORS_ORIGINS` in `api.env`) lists both origins. If ACAO appears twice, remove `Access-Control-*` from `caddy/Caddyfile`, validate, and reload Caddy. |
| Droplet unreachable | DO console, droplet status | Power cycle from the DO console, with approval. |



## Deploy checklist (API)

Required before the first production API deploy (and every rotate):

1. **TOKEN_ENC_KEY set to a fresh, valid prod key** — 64 hex chars (`openssl rand -hex 32`). Never the example from `.env.example` / compose, never all-identical digits, never commit the value.
2. `BLIZZARD_MOCK=false` with real `BLIZZARD_CLIENT_ID` / `BLIZZARD_CLIENT_SECRET`.
3. `BLIZZARD_REGIONS` set for the Forever regions you serve.
4. `SESSION_SECRET` is unique and ≥32 bytes of entropy.
5. Migrations applied (`npm run migrate` / image entrypoint).
6. `curl -fsS https://api.crusaderstrike.com/healthz` returns 200 after cutover.

## TOKEN_ENC_KEY rotation

Blizzard OAuth tokens are stored AES-256-GCM encrypted with prefix `v1:`. The key lives only in the operator vault / droplet env — **never in the repo**. Platform Dev (and Bot for deploy) can rotate it.

### Generate a key
```
openssl rand -hex 32
```

### Rotate without forcing every user to re-login
1. Set `TOKEN_ENC_KEY` to the **new** key and `TOKEN_ENC_KEY_PREVIOUS` to the **old** key (decrypt-only).
2. Redeploy. New logins encrypt with the new key (`v1:` payload under the new key). Existing `v1:` rows still decrypt via the previous key.
3. Optional grace: after most sessions have refreshed or re-authed, clear `TOKEN_ENC_KEY_PREVIOUS` and redeploy. Tokens that still only decrypt with the old key will fail closed and force re-login (see below).
4. Future scheme bump: new writes can move to a `v2:` prefix while `v1:` continues to decrypt during a grace window; retire `v1:` / the previous key after the window.

### Force re-login fallback
If you cannot keep the previous key (compromise, lost key), deploy with only the new `TOKEN_ENC_KEY`. Any stored token that is missing the `v1:` prefix or fails decrypt is cleared; the user gets `401 unauthenticated` and must sign in again. Logs include `user_id` and error code only — **never the key or token material**.

### Where the key is stored
Operator vault and `/opt/crusaderstrike/api.env` on the droplet (mode 0600; never overwrite — append / rotate via `TOKEN_ENC_KEY_PREVIOUS`). Who can rotate: Platform Dev via Bot-approved deploy.

## Escalation
- All escalations go to **Bot** (agent 7c6c7f59-8679-4bad-92c0-48dd033eac7c), never directly to Drew. Bot decides whether to involve Drew.
- Any paid DO change (resize, extra uptime checks, backups, Spaces) needs a price check with Bot first.
