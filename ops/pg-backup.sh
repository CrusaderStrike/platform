#!/usr/bin/env bash
# Nightly Postgres backup to DO Spaces (platform#8). Retention: 7 daily + 4 weekly (weekly = UTC Sunday).
# Dump is verified (pg_restore --list), then encrypted with age before upload.
set -euo pipefail
umask 077
ENV=/opt/crusaderstrike/backup.env
S3CFG=/opt/crusaderstrike/s3cfg            # root 0600, holds the Spaces key; keeps secrets out of argv
AGE_KEY=/opt/crusaderstrike/backup-age.key # root 0600, age identity; public recipient derived from it
DIR=/var/backups/crusaderstrike/offsite
set -a; . "$ENV"; set +a
: "${SPACES_BUCKET:?}" "${SPACES_REGION:?}" "${SPACES_KEY:?}" "${SPACES_SECRET:?}"
# (Re)write the s3cmd config from backup.env; never pass keys on the command line.
cat > "$S3CFG" <<CFG
[default]
access_key = $SPACES_KEY
secret_key = $SPACES_SECRET
host_base = $SPACES_REGION.digitaloceanspaces.com
host_bucket = %(bucket)s.$SPACES_REGION.digitaloceanspaces.com
use_https = True
CFG
chmod 600 "$S3CFG"
unset SPACES_KEY SPACES_SECRET
S3=(s3cmd -c "$S3CFG" --ssl)
RECIPIENT=$(age-keygen -y "$AGE_KEY")

TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$DIR"; chmod 700 "$DIR"
F="$DIR/crusaderstrike-$TS.dump"; E="$F.age"
trap 'rm -f "$F" "$E" "$E.sha256"' EXIT

docker exec crusaderstrike-postgres-1 pg_dump -U postgres -d crusaderstrike -Fc -Z 6 > "$F"
chmod 600 "$F"
# Verify the archive is readable before uploading it.
docker exec -i crusaderstrike-postgres-1 pg_restore --list < "$F" > /dev/null
age -r "$RECIPIENT" -o "$E" "$F"
( cd "$DIR" && sha256sum "$(basename "$E")" > "$E.sha256" )

up() { "${S3[@]}" put --acl-private --quiet "$E" "$E.sha256" "s3://$SPACES_BUCKET/postgres/$1/"; }
up daily
if [ "$(date -u +%u)" = 7 ]; then up weekly; fi   # %u=7 is Sunday in UTC

prune() { # keep newest N dumps (and their .sha256) under postgres/$1/
  "${S3[@]}" ls "s3://$SPACES_BUCKET/postgres/$1/" | awk '$4 ~ /\.dump(\.age)?$/ {print $4}' | sort -r \
    | tail -n +$(( $2 + 1 )) | while read -r o; do "${S3[@]}" del --quiet "$o"; "${S3[@]}" del --quiet "$o.sha256" 2>/dev/null || true; done
}
prune daily 7; prune weekly 4
echo "$(date -u +%FT%TZ) backup ok: postgres/daily/$(basename "$E")"
