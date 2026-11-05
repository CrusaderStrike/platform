# CrusaderStrike Platform Runbook (crusaderstrike-platform-1)
No secrets live in this file. Keys and tokens are in the operator vault or under /home/box/.config/do-platform/ on the agent box.

## Architecture
- DigitalOcean droplet `crusaderstrike-platform-1` (id 616006981), region sfo3, size s-1vcpu-2gb (1 vCPU, 2 GB RAM, 50 GB disk, 2 GB swap), Ubuntu 24.04.5 LTS, public IP 24.199.127.192.
- Stack in `/opt/crusaderstrike`:
  - `docker-compose.yml`: postgres:16 (container `crusaderstrike-postgres-1`), bound to 127.0.0.1:5432 only. `initdb/` holds the init scripts.
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
- Allowed origins: `https://crusaderstrike.com` and `https://www.crusaderstrike.com` (both are first-class origins). No other origin gets CORS headers.
- Applied in `caddy/Caddyfile` (matcher `@cors_origin`) on every API path, including `/healthz`: `Access-Control-Allow-Origin` reflects the request origin, `Vary: Origin`, methods `GET, POST, PUT, PATCH, DELETE, OPTIONS`, headers `Content-Type, X-CSRF-Token`, max-age 600. Preflight `OPTIONS` from an allowed origin gets `204` at Caddy.
- Signup (`POST /signups`) is uncredentialed. When auth/session goes live, add `Access-Control-Allow-Credentials: true` (never with `*`). Caddy and the app must stay in sync; if the app later sets CORS itself, remove it from Caddy so headers are not duplicated.
- **Expose `Retry-After`:** the Fastify app sets `Access-Control-Expose-Headers: Retry-After` so the browser can read the 429 countdown on `POST /api/v1/me/characters/refresh`. If CORS headers are still emitted from the droplet `caddy/Caddyfile`, add the matching expose header there too, e.g. `Access-Control-Expose-Headers Retry-After` (or append to an existing expose list). Keep Caddy and the app in sync; do not leave expose only on one layer. (Documented here for the next Caddy edit — do not change the live droplet from this PR alone.)
- Check:
  ```
  curl -sI -H 'Origin: https://crusaderstrike.com' https://api.crusaderstrike.com/healthz | grep -i access-control
  curl -si -X OPTIONS -H 'Origin: https://www.crusaderstrike.com' -H 'Access-Control-Request-Method: POST' https://api.crusaderstrike.com/signups | head -1   # expect 204
  ```
  Expect `access-control-allow-origin` equal to the Origin sent. An unlisted origin must get no ACAO header.
- Agents running: DO metrics agent (`do-agent`) and `droplet-agent` are both active.

## Access
- SSH: `ssh -i <platform key> root@24.199.127.192`. All commands in this runbook assume `root` (key-only; root login stays enabled with `prohibit-password`, password auth is off). The `deploy` user is key-only and reserved for a future CI deploy.
- DO API: a scoped token used by the Platform Dev agent. Never print it or commit it.

## Website (GitHub Pages)
- Source: [CrusaderStrike/web](https://github.com/CrusaderStrike/web), workflow `.github/workflows/deploy-pages.yml` ("Deploy to GitHub Pages"), runs on every push to `main` and on `workflow_dispatch`. Custom domain (CNAME) `crusaderstrike.com`, HTTPS enforced.
- Deploy: merge the PR (or push) to `web` `main`. Watch Actions until "Deploy to GitHub Pages" succeeds, then check `curl -fsSI https://crusaderstrike.com` and `curl -fsSI https://www.crusaderstrike.com`.
- Rollback: `git revert <bad sha>` on `main` and push (or run the workflow via `workflow_dispatch` on a known-good SHA). Confirm the Pages deployment finished and the site serves the old version. Do **not** touch the droplet for site content.
- www TLS: the Pages certificate must cover both `crusaderstrike.com` and `www.crusaderstrike.com` (www redirects to apex). If www TLS breaks (cert lists only the apex), re-set the Pages custom domain in web → Settings → Pages: clear it, save, set `crusaderstrike.com` again and save. That re-issues the cert including www. Wait for "Certificate provisioned", then re-enable "Enforce HTTPS". Confirm the www CNAME still points to `crusaderstrike.github.io`.

## Deploy and restart (API droplet)
Before pulling, record the current image digests so you can roll back, and take a fresh backup before anything that touches Postgres:
```
docker inspect --format '{{.Config.Image}} {{.Image}}' crusaderstrike-postgres-1 crusaderstrike-caddy-1 >> /root/image-digests.log
/usr/local/bin/crusaderstrike-backup
```
```
cd /opt/crusaderstrike
docker compose -f docker-compose.yml -f docker-compose.caddy.yml ps
docker compose -f docker-compose.yml -f docker-compose.caddy.yml pull
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
docker compose ... restart caddy        # or postgres
docker compose ... logs --tail=200 caddy
```
After any change, check that `curl -fsS https://api.crusaderstrike.com/healthz` returns 200 and the CORS check under Architecture still passes.

Rollback: pin the image in the compose file to the previous digest from `/root/image-digests.log` (e.g. `image: caddy@sha256:...`) and `up -d` again.

Caddyfile changes: back up first (`cp -p caddy/Caddyfile caddy/Caddyfile.bak-$(date +%Y%m%d%H%M%S)`), edit, then `docker exec crusaderstrike-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`. To roll back, copy the backup over and reload.

## Backups
- Cron: `/etc/cron.d/crusaderstrike-backup` runs `0 3 * * * root /usr/local/bin/crusaderstrike-backup` and logs to `/var/log/crusaderstrike-backup.log`. Times are UTC (7 PM PST or 8 PM PDT).
- Output: `/var/backups/crusaderstrike/crusaderstrike-YYYY-MM-DD_HHMM.dump` (`pg_dump -U postgres -Fc crusaderstrike`, custom format, mode 0600). Database `crusaderstrike`, superuser `postgres`; the password is in `/opt/crusaderstrike/.env` and is never copied out. The last 7 days are kept.
- Off-site copies are not set up yet. That waits on [#8](https://github.com/CrusaderStrike/platform/issues/8) (Spaces bucket and key).
- Verify: `ls -la /var/backups/crusaderstrike` and `tail /var/log/crusaderstrike-backup.log`.

### Restore
1. Get approval through Bot first, because a restore overwrites data.
2. Stop writers: `docker compose ... stop caddy` (or the app container, once one exists).
3. Copy the dump into the container: `docker cp /var/backups/crusaderstrike/<file>.dump crusaderstrike-postgres-1:/tmp/r.dump`
4. Restore: `docker exec crusaderstrike-postgres-1 pg_restore -U postgres -d crusaderstrike --clean --if-exists /tmp/r.dump`
5. Start caddy again and check /healthz. Then spot-check the row counts.
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
| Browser CORS error from the site | CORS check under Architecture | Confirm the `@cors_origin` block in the Caddyfile lists both origins, then reload Caddy. |
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
Operator vault and `/opt/crusaderstrike/.env` on the droplet (mode 0600). Who can rotate: Platform Dev via Bot-approved deploy.

## Escalation
- All escalations go to **Bot** (agent 7c6c7f59-8679-4bad-92c0-48dd033eac7c), never directly to Drew. Bot decides whether to involve Drew.
- Any paid DO change (resize, extra uptime checks, backups, Spaces) needs a price check with Bot first.
