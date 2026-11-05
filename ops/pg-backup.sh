#!/usr/bin/env bash
# Nightly Postgres backup to DO Spaces (platform#8). Retention: 7 daily + 4 weekly.
set -euo pipefail
set -a; . /opt/crusaderstrike/backup.env; set +a
S3="s3cmd --access_key=$SPACES_KEY --secret_key=$SPACES_SECRET --host=$SPACES_REGION.digitaloceanspaces.com --host-bucket=%(bucket)s.$SPACES_REGION.digitaloceanspaces.com"
TS=$(date -u +%Y%m%dT%H%M%SZ); F=/var/backups/crusaderstrike/crusaderstrike-$TS.dump
mkdir -p /var/backups/crusaderstrike; chmod 700 /var/backups/crusaderstrike
docker exec crusaderstrike-postgres-1 pg_dump -U postgres -d crusaderstrike -Fc -Z 6 > "$F"
$S3 put --acl-private --quiet "$F" "s3://$SPACES_BUCKET/postgres/daily/$(basename $F)"
if [ "$(date -u +%u)" = 7 ]; then $S3 put --acl-private --quiet "$F" "s3://$SPACES_BUCKET/postgres/weekly/$(basename $F)"; fi
prune() { $S3 ls "s3://$SPACES_BUCKET/postgres/$1/" | awk '{print $4}' | sort -r | tail -n +$(( $2 + 1 )) | while read -r o; do $S3 del --quiet "$o"; done; }
prune daily 7; prune weekly 4
rm -f "$F"
echo "backup ok: postgres/daily/$(basename $F)"
