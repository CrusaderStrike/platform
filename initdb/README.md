# Postgres init roles (production droplet)

`01-roles.sh` creates `crusaderstrike_migrate` and `crusaderstrike_app`.

On the droplet, copy this directory to `/opt/crusaderstrike/initdb/` and mount it from the **production** compose file (not the repo's local `docker-compose.yml`):

```yaml
volumes:
  - ./initdb:/docker-entrypoint-initdb.d:ro
```

Pass `MIGRATE_PASSWORD` and `APP_PASSWORD` via the postgres service env (from `/opt/crusaderstrike/.env`). Never print them.

For an existing volume, see `docs/runbook.md` → "Postgres roles".
