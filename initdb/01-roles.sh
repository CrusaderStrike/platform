#!/usr/bin/env bash
# Create/repair crusaderstrike_migrate + crusaderstrike_app.
# Idempotent (safe to run twice).
#
# Passwords come ONLY from env MIGRATE_PASSWORD and APP_PASSWORD
# (compose env_file, or `docker exec -e …`). Never print them, never pass
# them as lasting argv to helper tools — feed psql via libpq variables
# (`-v` + :'pw') or SQL on stdin.
#
# Fresh volume: production compose mounts this dir at
#   ./initdb:/docker-entrypoint-initdb.d:ro
# and supplies MIGRATE_PASSWORD / APP_PASSWORD from /opt/crusaderstrike/.env.
#
# Existing DB:
#   docker exec -i -e MIGRATE_PASSWORD -e APP_PASSWORD \
#     crusaderstrike-postgres-1 bash -s < /opt/crusaderstrike/initdb/01-roles.sh
set -euo pipefail

: "${MIGRATE_PASSWORD:?MIGRATE_PASSWORD is required}"
: "${APP_PASSWORD:?APP_PASSWORD is required}"

if [ -z "${MIGRATE_PASSWORD// }" ] || [ -z "${APP_PASSWORD// }" ]; then
  echo "MIGRATE_PASSWORD and APP_PASSWORD must be non-empty" >&2
  exit 1
fi

psql_base=(psql -v ON_ERROR_STOP=1 -U postgres)

DB_EXISTS="$("${psql_base[@]}" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'crusaderstrike'")"
if [ "$DB_EXISTS" != "1" ]; then
  "${psql_base[@]}" -d postgres -c "CREATE DATABASE crusaderstrike"
fi

# Create role if missing; always sync password from env so .env stays source of truth.
# Uses psql -v + :'pw' (bound parameter) rather than interpolating into SQL text.
ensure_role() {
  local role="$1"
  local attrs="$2"   # e.g. "LOGIN BYPASSRLS" or "LOGIN NOBYPASSRLS"
  local password="$3"
  local exists
  exists="$("${psql_base[@]}" -d crusaderstrike -tAc "SELECT 1 FROM pg_roles WHERE rolname = '${role}'")"
  if [ "$exists" != "1" ]; then
    "${psql_base[@]}" -d crusaderstrike -v pw="$password" \
      -c "CREATE ROLE ${role} ${attrs} PASSWORD :'pw'"
  else
    "${psql_base[@]}" -d crusaderstrike -v pw="$password" \
      -c "ALTER ROLE ${role} PASSWORD :'pw'"
    # Keep attribute flags aligned with the intended role.
    "${psql_base[@]}" -d crusaderstrike -c "ALTER ROLE ${role} ${attrs}"
  fi
}

ensure_role crusaderstrike_migrate "LOGIN BYPASSRLS" "$MIGRATE_PASSWORD"
ensure_role crusaderstrike_app "LOGIN NOBYPASSRLS" "$APP_PASSWORD"

"${psql_base[@]}" -d crusaderstrike <<'SQL'
ALTER DATABASE crusaderstrike OWNER TO crusaderstrike_migrate;
ALTER SCHEMA public OWNER TO crusaderstrike_migrate;
GRANT CONNECT ON DATABASE crusaderstrike TO crusaderstrike_app;
GRANT USAGE ON SCHEMA public TO crusaderstrike_app;
ALTER DEFAULT PRIVILEGES FOR ROLE crusaderstrike_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crusaderstrike_app;
ALTER DEFAULT PRIVILEGES FOR ROLE crusaderstrike_migrate IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO crusaderstrike_app;
SQL

echo "roles_ok crusaderstrike_migrate crusaderstrike_app"
