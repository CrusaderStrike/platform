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
- Steps: `pg_dump -Fc -Z 6` of db `crusaderstrike` (container `crusaderstrike-postgres-1`) under `umask 077` (dump is 0600) → verify with `pg_restore --list` → encrypt with `age` → upload `.dump.age` + `.sha256` → prune. A `trap` removes local temp files on any exit.
- Destination: private Spaces bucket `crusaderstrike-backups` (sfo3), HTTPS (`--ssl`), `--acl-private`.
  - `postgres/daily/`: newest 7 kept.
  - `postgres/weekly/`: copy taken when the **UTC** day is Sunday (`date -u +%u` = 7), newest 4 kept.
- Cost: Spaces is $5/mo base (250 GiB included). The bucket already existed when #8 started; no new billable resource was created.

## Secrets and keys (never commit, never print)
- `/opt/crusaderstrike/backup.env` (root, 0600): SPACES_KEY, SPACES_SECRET, SPACES_REGION, SPACES_BUCKET.
- `/opt/crusaderstrike/s3cfg` (root, 0600): s3cmd config generated from backup.env each run, so keys never appear on the command line / in `ps`.
- `/opt/crusaderstrike/backup-age.key` (root, 0600): age identity. **Without it no backup can be decrypted.** A copy is kept on the Grok box at `/home/box/.config/do-platform/backup-age.key` (0600). That copy must itself be backed up (e.g. into the team password vault); losing both copies means losing every backup.
- Don't leave `backup.env` exported in a shared shell; the scripts source it themselves.

## Run a backup by hand
    /opt/crusaderstrike/pg-backup.sh

## Test restore (safe; do this first)
    s3cmd -c /opt/crusaderstrike/s3cfg --ssl ls s3://crusaderstrike-backups/postgres/daily/   # pick an object
    /opt/crusaderstrike/pg-restore.sh crusaderstrike-<UTC ts>.dump.age

This downloads to a private temp dir, decrypts, verifies, runs `dropdb --if-exists restore_test` + `createdb restore_test`, restores, prints table counts, drops `restore_test`, and deletes temp files.

## Production restore (overwrites live data)
1. **Get Bot's OK first**, naming the object to restore. Do not proceed without it.
2. Run a test restore of the same object (above) and check the counts.
3. Run:

       /opt/crusaderstrike/pg-restore.sh crusaderstrike-<UTC ts>.dump.age --production --yes-production

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
