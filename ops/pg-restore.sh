#!/usr/bin/env bash
# Restore a Spaces backup (platform#8).
#   The age private key is NOT stored on the droplet: pass --identity <file> or set AGE_IDENTITY=<file>.
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
case "$OBJ" in *.age) [ -n "$AGE_KEY" ] && [ -r "$AGE_KEY" ] || { echo "refusing: encrypted backup needs the age private key via --identity <file> or AGE_IDENTITY"; exit 2; };; esac
S3CFG=/opt/crusaderstrike/s3cfg
BUCKET=$(. /opt/crusaderstrike/backup.env; echo "$SPACES_BUCKET")
PG=crusaderstrike-postgres-1; COMPOSE="docker compose -f /opt/crusaderstrike/docker-compose.yml -f /opt/crusaderstrike/docker-compose.caddy.yml"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
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
$COMPOSE stop caddy                                     # blocks all public traffic to the API
if $COMPOSE config --services | grep -qx api; then $COMPOSE stop api; fi
docker exec -i $PG pg_restore -U postgres -d crusaderstrike --clean --if-exists --no-owner --exit-on-error < "$TMP/r.dump"
counts crusaderstrike
if $COMPOSE config --services | grep -qx api; then $COMPOSE start api; fi
$COMPOSE start caddy
for i in $(seq 1 30); do curl -fsS -o /dev/null -w '%{http_code}\n' https://api.crusaderstrike.com/healthz && { echo "production restore ok: $OBJ"; exit 0; }; sleep 2; done
echo "healthz NOT 200 after restore - investigate now"; exit 1
