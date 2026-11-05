# Database backups and restore (platform#8)

Kept as its own file so it doesn't conflict with `docs/runbook.md` (PR #26). The runbook should link here for restores.

## What runs
- Script: `/opt/crusaderstrike/pg-backup.sh` (source `ops/pg-backup.sh`, mode 0700 on the droplet, 755 in git).
- Restore: `/opt/crusaderstrike/pg-restore.sh` (source `ops/pg-restore.sh`).
- Schedule (all times UTC), two non-overlapping jobs:

  | Cron file | Line | Job |
  |---|---|---|
  | `/etc/cron.d/crusaderstrike-backup` | `0 3 * * * root /usr/local/bin/crusaderstrike-backup >> /var/log/crusaderstrike-backup.log 2>&1` | Local-only dump (runbook #26), 03:00 UTC |
  | `/etc/cron.d/crusaderstrike-offsite-backup` | `30 10 * * * root /opt/crusaderstrike/pg-backup.sh >> /var/log/crusaderstrike-backup.log 2>&1` | Encrypted off-site dump (this doc), 10:30 UTC = 03:30 PDT / 02:30 PST |

  The off-site cron file is in git as `ops/crusaderstrike-offsite-backup.cron`.
- Steps: `pg_dump -Fc -Z 6` of db `crusaderstrike` (container `crusaderstrike-postgres-1`) under `umask 077` (dump is 0600) → verify with `pg_restore --list` → encrypt with `age -R /opt/crusaderstrike/backup-age.pub` (public key only) → upload `.dump.age` + `.sha256` → prune → ping Healthchecks.io. A `trap` removes local temp files on any exit and pings `$HC_PING_URL/fail` if the run failed.
- Missed-backup alert: Healthchecks.io check (period 1 day + grace 2 hours, i.e. alerts after 26 h without a ping; emails platform@crusaderstrike.com). The ping URL lives only in `backup.env` as `HC_PING_URL`; it is not in git. `curl` reads it from stdin (`-K -`), so it never appears in argv.
- Destination: private Spaces bucket `crusaderstrike-backups` (sfo3), HTTPS (`--ssl`), `--acl-private`.
  - `postgres/daily/`: newest 7 kept.
  - `postgres/weekly/`: copy taken when the **UTC** day is Sunday (`date -u +%u` = 7), newest 4 kept.
- Cost: Spaces is $5/mo base (250 GiB included). The bucket already existed when #8 started; no new billable resource was created.

## Secrets and keys (never commit, never print)
- `/opt/crusaderstrike/backup.env` (root, 0600): SPACES_KEY, SPACES_SECRET, SPACES_REGION, SPACES_BUCKET, HC_PING_URL.
- `/opt/crusaderstrike/s3cfg` (root, 0600): s3cmd config generated from backup.env each run, so keys never appear on the command line / in `ps`.
- `/opt/crusaderstrike/backup-age.pub` (root, 0644): age **public** recipient used to encrypt. The droplet holds no private key, so a compromised droplet cannot decrypt old backups.
- The age **private** key (identity) is kept off the droplet in two places: the Grok box at `/home/box/.config/do-platform/backup-age.key` (0600) and Drew's drewnix secrets file `/home/drew/.bot/secrets/shared` as the `BACKUP_AGE_KEY` line (0600). **Losing both copies means losing every backup.**
- Restores take the identity at run time: `--identity <file>` or `AGE_IDENTITY=<file>`. The script refuses an encrypted backup without it. Pass `--identity -` to stream it on stdin: the script writes it to a 0600 file in `/dev/shm` (RAM) and a trap shreds it on exit. If `/opt/crusaderstrike/s3cfg` is missing, the script regenerates it from `backup.env` at 0600 or fails with a clear message.
- Don't leave `backup.env` exported in a shared shell; the scripts source it themselves.

## Run a backup by hand
    /opt/crusaderstrike/pg-backup.sh

## Test restore (safe; do this first)
    s3cmd -c /opt/crusaderstrike/s3cfg --ssl ls s3://crusaderstrike-backups/postgres/daily/   # pick an object
    # from the box: stream the identity into a 0600 temp file, restore, shred
    ssh root@24.199.127.192 '/opt/crusaderstrike/pg-restore.sh crusaderstrike-<UTC ts>.dump.age --identity -' < /home/box/.config/do-platform/backup-age.key

This downloads to a private temp dir, decrypts, verifies, runs `dropdb --if-exists restore_test` + `createdb restore_test`, restores, prints table counts, drops `restore_test`, and deletes temp files.

## Production restore (overwrites live data)
1. **Get Bot's OK first**, naming the object to restore. Do not proceed without it.
2. Run a test restore of the same object (above) and check the counts.
   **Rule: the droplet must never get access to drewnix.** No ssh, keys, or credentials for drewnix on the droplet, and no droplet script references drewnix. The key streams **drewnix → box → droplet** on stdin only, exactly like the test restore.
3. Run **from the box** (the key is read read-only on drewnix, piped through the box without touching its disk, and never printed):

       ssh drew@drewnix "sed -n 's/^BACKUP_AGE_KEY[=:][[:space:]]*//p' /home/drew/.bot/secrets/shared" \
         | ssh root@24.199.127.192 '/opt/crusaderstrike/pg-restore.sh crusaderstrike-<UTC ts>.dump.age --production --yes-production --confirm-db crusaderstrike --identity -'

   Mask-safe: don't add `-x`, `tee`, or `echo` to this pipe, and don't log its stdin. On the droplet the script writes the identity to a 0600 file in `/dev/shm` (RAM) and its EXIT trap shreds it. If the restore fails after the stop, the trap restarts `api` (if present) and `caddy` and runs the `/healthz` check.

   Because stdin carries the key, confirmation is `--confirm-db crusaderstrike` (on an interactive tty without `--identity -` it asks you to type it). Then it:
   - stops writers: `docker compose -f /opt/crusaderstrike/docker-compose.yml -f /opt/crusaderstrike/docker-compose.caddy.yml stop caddy` (blocks all public API traffic), and `... stop api` once an `api` service exists (today the compose services are only `caddy` and `postgres`);
   - `pg_restore --clean --if-exists --no-owner --exit-on-error` into `crusaderstrike`, then prints row counts;
   - starts `api` (if present) and `caddy` again;
   - checks `curl -fsS https://api.crusaderstrike.com/healthz` returns 200 (retries for 60 s) and exits non-zero if not.
4. Spot-check a few rows, and report the result to Bot.

## Verification log
- 2026-11-04 (Pacific): first unencrypted backup `postgres/daily/crusaderstrike-20261105T021102Z.dump`; restore into `restore_test` rc=0, 0 = 0 tables (no app tables yet). Anonymous GET → 403.
- 2026-11-04 (Pacific): encrypted backup `postgres/daily/crusaderstrike-20261105T021643Z.dump.age` (2,381 bytes) + `.sha256`, rc=0. `pg-restore.sh` test restore rc=0 (pre-existing `restore_test` dropped and re-created, then dropped). Production gate refused without `--yes-production` and with a wrong typed name (rc=2). healthz 200.
- Re-run the test restore once real app tables exist.
- 2026-11-04 (Pacific): switched to public-key-only. Backup `postgres/daily/crusaderstrike-20261105T024603Z.dump.age` encrypted with `age -R backup-age.pub`, rc=0, Healthchecks success ping sent (curl rc=0). Restore refused without identity (rc=2); test restore with `--identity` and with `AGE_IDENTITY` rc=0 (tables=0, DB still empty). Private key then shredded from the droplet.
- 2026-11-04 (Pacific): review fixes. Backup `postgres/daily/crusaderstrike-20261105T025544Z.dump.age` rc=0; Healthchecks ping via `curl -K -` rc=0. Test restore with `--identity -` (identity in /dev/shm 0600, shredded; none left after) rc=0, tables=0; `s3cfg` was removed first and regenerated at 0600. Production-failure trap not exercised live (would take the site down).
- 2026-11-04 (Pacific): production key flow changed to drewnix → box → droplet on stdin (droplet never reaches drewnix; grep of /opt/crusaderstrike, /root, /etc/cron* finds no drewnix reference). Added `--confirm-db`. Gate refused with key on stdin and no confirm (rc=2) and wrong confirm (rc=2), before any stop; no identity left in /dev/shm. Test restore with `--identity -` ok.
