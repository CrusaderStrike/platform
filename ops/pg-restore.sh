#!/usr/bin/env bash
# Restore a Spaces backup (platform#8).
#   The age private key is NOT stored on the droplet: pass --identity <file|-> or set AGE_IDENTITY=<file>.
#   The identity is copied to a 0600 file in /dev/shm and shredded on exit.
#   If a production restore fails after services are stopped, the EXIT trap restarts api/caddy and checks /healthz.
#   Test (safe, default):  pg-restore.sh <object-name>            -> restores into restore_test, prints counts, drops it
#   Production:            pg-restore.sh <object-name> --production --yes-production
#     Production requires Bot's OK first (see docs/backups.md) and typing the db name to confirm.
set -euo pipefail
umask 077
AGE_KEY=${AGE_IDENTITY:-}; ARGS=()
while [ $# -gt 0 ]; do case "$1" in --identity) AGE_KEY=${2:?--identity needs a file}; shift 2;; --identity=*) AGE_KEY=${1#*=}; shift;; *) ARGS+=("$1"); shift;; esac; done
set -- "${ARGS[@]}"
OBJ=${1:?usage: pg-restore.sh <crusaderstrike-...dump.age> [--production --yes-production] (--identity <file> | AGE_IDENTITY=<file>)}
MODE=test; [ "${2:-}" = --production ] && MODE=prod
case "$OBJ" in *.age) [ -n "$AGE_KEY" ] && { [ "$AGE_KEY" = - ] || [ -r "$AGE_KEY" ]; } || { echo "refusing: encrypted backup needs the age private key via --identity <file> or AGE_IDENTITY"; exit 2; };; esac
S3CFG=/opt/crusaderstrike/s3cfg; ENV=/opt/crusaderstrike/backup.env
BUCKET=$(. "$ENV"; echo "$SPACES_BUCKET")
PG=crusaderstrike-postgres-1; COMPOSE="docker compose -f /opt/crusaderstrike/docker-compose.yml -f /opt/crusaderstrike/docker-compose.caddy.yml"
TMP=$(mktemp -d); IDF=""; STOPPED=0; DONE=0
healthz() { for i in $(seq 1 30); do curl -fsS -o /dev/null https://api.crusaderstrike.com/healthz && return 0; sleep 2; done; return 1; }
restart_services() {
  if $COMPOSE config --services | grep -qx api; then $COMPOSE start api; fi
  $COMPOSE start caddy
}
cleanup() { rc=$?
  [ -n "$IDF" ] && [ -f "$IDF" ] && shred -u "$IDF"
  rm -rf "$TMP"
  if [ "$STOPPED" = 1 ] && [ "$DONE" = 0 ]; then
    echo "production restore FAILED (rc=$rc) after services were stopped; restarting them" >&2
    restart_services || echo "restart failed - investigate now" >&2
    healthz && echo "healthz 200 after failed restore (live DB may be partially restored - investigate)" >&2 \
            || echo "healthz NOT 200 after failed restore - investigate now" >&2
  fi
  exit $rc
}
trap cleanup EXIT; trap 'exit 1' INT TERM
# s3cmd config: regenerate from backup.env (0600) if missing.
if [ ! -s "$S3CFG" ]; then
  ( set -a; . "$ENV"; set +a
    : "${SPACES_KEY:?s3cfg missing and SPACES_KEY not in backup.env}" "${SPACES_SECRET:?s3cfg missing and SPACES_SECRET not in backup.env}" "${SPACES_REGION:?}"
    umask 077; cat > "$S3CFG" <<CFG
[default]
access_key = $SPACES_KEY
secret_key = $SPACES_SECRET
host_base = $SPACES_REGION.digitaloceanspaces.com
host_bucket = %(bucket)s.$SPACES_REGION.digitaloceanspaces.com
use_https = True
CFG
  ) || { echo "refusing: $S3CFG missing and could not be regenerated from $ENV" >&2; exit 2; }
  chmod 600 "$S3CFG"; echo "regenerated $S3CFG from backup.env"
fi
# Identity: copy to a 0600 file in /dev/shm (RAM), shredded by the EXIT trap. '-' reads it from stdin.
if [ -n "$AGE_KEY" ]; then
  IDF=$(mktemp -p /dev/shm restore-id.XXXXXX); chmod 600 "$IDF"
  if [ "$AGE_KEY" = - ]; then cat > "$IDF"; else cat "$AGE_KEY" > "$IDF"; fi
  [ -s "$IDF" ] || { echo "refusing: empty age identity" >&2; exit 2; }
  AGE_KEY=$IDF
fi
s3cmd -c "$S3CFG" --ssl get --quiet "s3://$BUCKET/postgres/daily/$OBJ" "$TMP/$OBJ" \
  || s3cmd -c "$S3CFG" --ssl get --quiet "s3://$BUCKET/postgres/weekly/$OBJ" "$TMP/$OBJ"
case "$OBJ" in *.age) age -d -i "$AGE_KEY" -o "$TMP/r.dump" "$TMP/$OBJ";; *) mv "$TMP/$OBJ" "$TMP/r.dump";; esac
docker exec -i $PG pg_restore --list < "$TMP/r.dump" > /dev/null
counts() { docker exec $PG psql -U postgres -d "$1" -Atc "select relname||'='||n_live_tup from pg_stat_user_tables order by 1" ; \
           docker exec $PG psql -U postgres -d "$1" -Atc "select 'tables='||count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')"; }

if [ $MODE = test ]; then
  docker exec $PG dropdb -U postgres --if-exists restore_test
  docker exec $PG createdb -U postgres restore_test
  docker exec -i $PG pg_restore -U postgres -d restore_test --no-owner --exit-on-error < "$TMP/r.dump"
  echo "restore_test counts:"; counts restore_test
  docker exec $PG dropdb -U postgres restore_test
  echo "test restore ok: $OBJ"; exit 0
fi

# ---- Production restore: overwrites live data ----
[ "${3:-}" = --yes-production ] || { echo "refusing: production restore needs --production --yes-production (and Bot's OK)"; exit 2; }
read -r -p "Bot approved this restore? Type the database name (crusaderstrike) to overwrite it: " ans
[ "$ans" = crusaderstrike ] || { echo "aborted"; exit 2; }
echo "Stopping writers..."
STOPPED=1
$COMPOSE stop caddy                                     # blocks all public traffic to the API
if $COMPOSE config --services | grep -qx api; then $COMPOSE stop api; fi
docker exec -i $PG pg_restore -U postgres -d crusaderstrike --clean --if-exists --no-owner --exit-on-error < "$TMP/r.dump"
counts crusaderstrike
restart_services; DONE=1
healthz && { echo "production restore ok: $OBJ"; exit 0; }
echo "healthz NOT 200 after restore - investigate now"; exit 1
