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
   **Key steps (production):** fetch `BACKUP_AGE_KEY` read-only from drewnix `/home/drew/.bot/secrets/shared` straight into RAM on the droplet, pass it with `--identity`, then shred it. Never print it or copy it to disk:

       # on the droplet (key never touches disk; /dev/shm is RAM)
       umask 077; T=$(mktemp -p /dev/shm); chmod 600 $T
       ssh drew@drewnix "sed -n 's/^BACKUP_AGE_KEY[=:][[:space:]]*//p' /home/drew/.bot/secrets/shared" > $T   # read-only
       /opt/crusaderstrike/pg-restore.sh crusaderstrike-<UTC ts>.dump.age --production --yes-production --identity $T
       shred -u $T

   (The script also copies the identity into its own /dev/shm 0600 file and shreds it on exit.) If the restore fails after the stop, the EXIT trap restarts `api` (if present) and `caddy` and runs the `/healthz` check.
3. Run:

       /opt/crusaderstrike/pg-restore.sh crusaderstrike-<UTC ts>.dump.age --production --yes-production --identity <0600 temp file>   # shred it afterwards

   It asks you to type `crusaderstrike` to confirm, then:
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
