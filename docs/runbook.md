# CrusaderStrike Platform Runbook (crusaderstrike-platform-1)
No secrets live in this file. Keys and tokens are in the operator vault or under /home/box/.config/do-platform/ on the agent box.

## Architecture
- DigitalOcean droplet `crusaderstrike-platform-1` (id 616006981), region sfo3, size s-1vcpu-2gb (1 vCPU, 2 GB RAM, 50 GB disk, 2 GB swap), Ubuntu 24.04.5 LTS, public IP 24.199.127.192.
- Stack in `/opt/crusaderstrike`:
  - `docker-compose.yml`: postgres:16 (container `crusaderstrike-postgres-1`), bound to 127.0.0.1:5432 only. `initdb/` holds the init scripts.
  - `docker-compose.caddy.yml` and `caddy/Caddyfile`: caddy:2 (container `crusaderstrike-caddy-1`) on ports 80 and 443 (TCP and UDP/HTTP3). It handles TLS automatically.
- Public endpoint: https://api.crusaderstrike.com/healthz should return 200.
- Agents running: DO metrics agent (`do-agent`) and `droplet-agent` are both active.

## Access
- SSH: `ssh -i <platform key> root@24.199.127.192` (for ops). The `deploy` user uses key-only login and password authentication is off.
- DO API: a scoped token used by the Platform Dev agent. Never print it or commit it.

## Deploy and restart
```
cd /opt/crusaderstrike
docker compose -f docker-compose.yml -f docker-compose.caddy.yml ps
docker compose -f docker-compose.yml -f docker-compose.caddy.yml pull
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
docker compose ... restart caddy        # or postgres
docker compose ... logs --tail=200 caddy
```
After any change, check that `curl -fsS https://api.crusaderstrike.com/healthz` returns 200.

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
6. Test this procedure at least once a month by restoring into a scratch database (`createdb restore_test`).

## TLS
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
- Uptime check `227c7160-ea24-47b8-b5d2-a56630c25dd3` on https://crusaderstrike.com from us_west and us_east. This is the account's one free check (https://docs.digitalocean.com/products/uptime/details/pricing/). **Never create a second one; each extra check costs $1/month.**
- Planned alerts, all to platform@crusaderstrike.com: droplet CPU >80%, memory >90% and disk >80%, each over a 5-minute window; uptime alerts for down, latency >2000 ms, and TLS certificate expiry within 14 days.
- Status: the alerts are not created yet because DigitalOcean only accepts a verified team-member email as an alert recipient (see #24).

## Incident checklist
1. Check /healthz and https://crusaderstrike.com.
2. Run `docker ps` and look at the DO graphs.
3. Look up the symptom in the table below.
4. Fix it, then verify.
5. Report to Bot with the timeline.

## Common incidents
| Symptom | Check | Fix |
|---|---|---|
| Disk full | `df -h /`, `du -sh /var/lib/docker /var/backups/* /var/log` | `docker system prune` (images only, never volumes), trim old logs or dumps, check that backup rotation works. |
| Postgres down | `docker ps`, `docker compose logs postgres`, healthcheck | `docker compose up -d postgres`. If the volume is corrupt, restore from backup (with approval). |
| Caddy or cert error | `/healthz` fails, cert date, `logs caddy` | Restart caddy. Check DNS and ports 80 and 443. Watch for Let's Encrypt rate limits. |
| High CPU or memory | `top`, `docker stats`, DO graphs | Find the busy container and restart it. If it keeps happening, propose a resize (paid) through Bot. |
| Droplet unreachable | DO console, droplet status | Power cycle from the DO console, with approval. |

## Escalation
- All escalations go to **Bot** (agent 7c6c7f59-8679-4bad-92c0-48dd033eac7c), never directly to Drew. Bot decides whether to involve Drew.
- Any paid DO change (resize, extra uptime checks, backups, Spaces) needs a price check with Bot first.
