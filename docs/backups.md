# Database backups and restore (platform#8)

Kept as its own file so it doesn't conflict with `docs/runbook.md` in PR #26. The runbook should link here.

## What runs
- Script: `/opt/crusaderstrike/pg-backup.sh` on crusaderstrike-platform-1 (source: `ops/pg-backup.sh`).
- Schedule: `/etc/cron.d/crusaderstrike-backup`, daily at 10:30 UTC (03:30 PDT / 02:30 PST). Log: `/var/log/crusaderstrike-backup.log`.
- Dump: `pg_dump -Fc -Z 6` of db `crusaderstrike` from container `crusaderstrike-postgres-1`.
- Destination: private Spaces bucket `crusaderstrike-backups` (sfo3).
  - `postgres/daily/crusaderstrike-<UTC ts>.dump`: newest 7 kept.
  - `postgres/weekly/...`: Sunday copy, newest 4 kept.
  - The script deletes older copies after each upload.
- Credentials: `/opt/crusaderstrike/backup.env`, root-only, mode 0600. It holds SPACES_KEY, SPACES_SECRET, SPACES_REGION and SPACES_BUCKET. Never commit it.

## Run a backup by hand
    /opt/crusaderstrike/pg-backup.sh

## Restore
On the droplet, as root:

    set -a; . /opt/crusaderstrike/backup.env; set +a
    S3="s3cmd --access_key=$SPACES_KEY --secret_key=$SPACES_SECRET --host=sfo3.digitaloceanspaces.com --host-bucket=%(bucket)s.sfo3.digitaloceanspaces.com"
    $S3 ls s3://crusaderstrike-backups/postgres/daily/        # pick an object
    $S3 get s3://crusaderstrike-backups/postgres/daily/<file>.dump /tmp/r.dump
    # Test first in a throwaway DB:
    docker exec crusaderstrike-postgres-1 psql -U postgres -c "create database restore_test"
    docker exec -i crusaderstrike-postgres-1 pg_restore -U postgres -d restore_test --no-owner < /tmp/r.dump
    # Check table counts, then drop restore_test.
    # Real restore: stop the API, then
    docker exec -i crusaderstrike-postgres-1 pg_restore -U postgres -d crusaderstrike --clean --if-exists --no-owner < /tmp/r.dump
    rm /tmp/r.dump

Note: the key is bucket-scoped, so `s3cmd ls` (list all buckets) and bucket `info` return 403. That's expected.

## Verification log
- 2026-11-04: first backup `postgres/daily/crusaderstrike-20261105T021102Z.dump` (2,181 bytes). Restored into `restore_test` with pg_restore rc=0. Table counts matched, but the DB has no app tables yet, so 0 = 0. Test DB dropped. Anonymous GET on the object returns 403, so it's private.
