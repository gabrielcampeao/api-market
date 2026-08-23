#!/usr/bin/env bash
# Proves the backup -> restore -> migration/status -> API up -> data checked
# cycle actually works, without touching the real prod Postgres volume:
# dumps the live database, restores it into a brand-new throwaway
# container+volume+network (all "-drill" suffixed), boots a real api
# container against the restore, and diffs row counts against the live DB.
# Everything created here is torn down at the end (or on any failure, via
# the trap) — nothing here is meant to become part of the steady-state stack.
#
# Usage (from the repo root, on the deploy host):
#   ./scripts/backup-restore-drill.sh
set -euo pipefail

COMPOSE="docker compose -f docker-compose.prod.yml"
NET=pgrestore-drill-net
PG=pg-restore-drill
REDIS=redis-restore-drill
API=api-restore-drill
VOL=pgrestore_drill_data
DUMP="/tmp/marketplace-backup-drill.dump"
DRILL_PG_PASSWORD=drilltest

cleanup() {
  echo "--- tearing down drill resources ---"
  docker rm -f "$API" "$PG" "$REDIS" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  rm -f "$DUMP"
}
trap cleanup EXIT

echo "--- 1) backup: pg_dump the live database ---"
$COMPOSE exec -T postgres pg_dump -U marketplace -Fc marketplace > "$DUMP"
echo "backup written: $DUMP ($(du -h "$DUMP" | cut -f1))"

echo "--- 2) restore: brand-new Postgres container/volume, empty until restored ---"
docker network create "$NET" >/dev/null
docker volume create "$VOL" >/dev/null
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_USER=marketplace -e POSTGRES_PASSWORD="$DRILL_PG_PASSWORD" -e POSTGRES_DB=marketplace \
  -v "$VOL":/var/lib/postgresql/data \
  postgres:16-alpine >/dev/null

echo -n "waiting for restore-target postgres to be ready"
until docker exec "$PG" pg_isready -h localhost -U marketplace -d marketplace >/dev/null 2>&1; do
  echo -n "."
  sleep 1
done
echo " ready"

docker cp "$DUMP" "$PG":/tmp/backup.dump
docker exec -e PGPASSWORD="$DRILL_PG_PASSWORD" "$PG" pg_restore -h localhost -U marketplace -d marketplace --no-owner /tmp/backup.dump
echo "restore complete"

echo "--- 3) migration/status + API up against the restored database ---"
docker run -d --name "$REDIS" --network "$NET" redis:7-alpine >/dev/null

JWT_ACCESS_SECRET_DRILL=$(openssl rand -hex 32)
JWT_REFRESH_SECRET_DRILL=$(openssl rand -hex 32)

docker run -d --name "$API" --network "$NET" -p 127.0.0.1:3003:3000 \
  -e NODE_ENV=production -e PORT=3000 \
  -e DATABASE_URL="postgresql://marketplace:${DRILL_PG_PASSWORD}@${PG}:5432/marketplace?schema=public" \
  -e REDIS_URL="redis://${REDIS}:6379" \
  -e JWT_ACCESS_SECRET="$JWT_ACCESS_SECRET_DRILL" \
  -e JWT_REFRESH_SECRET="$JWT_REFRESH_SECRET_DRILL" \
  -e ADMIN_EMAIL=admin@marketplace.dev -e ADMIN_PASSWORD=DrillOnly123! \
  marketplace-api-prod-api >/dev/null

echo -n "waiting for api-restore-drill to report ready"
for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:3003/api/health/ready >/dev/null 2>&1; then
    echo " ready"
    break
  fi
  echo -n "."
  sleep 1
done

echo "--- prisma migrate deploy output from the drill container's boot ---"
docker logs "$API" 2>&1 | grep -iE "migrate|migration" || echo "(no migration lines found — check docker logs $API manually)"

READY_BODY=$(curl -sf http://127.0.0.1:3003/api/health/ready || echo "FAILED TO REACH API")
echo "GET /api/health/ready -> $READY_BODY"
if [ "$READY_BODY" = "FAILED TO REACH API" ]; then
  echo "--- full api-restore-drill logs (readiness failed, dumping for diagnosis) ---"
  docker logs "$API" 2>&1 | tail -80
fi

echo "--- 4) data check: row counts, restored vs live ---"
for table in users products orders payments order_items; do
  live=$($COMPOSE exec -T postgres psql -U marketplace -d marketplace -tAc "SELECT count(*) FROM ${table};" | tr -d '\r')
  restored=$(docker exec -e PGPASSWORD="$DRILL_PG_PASSWORD" "$PG" psql -h localhost -U marketplace -d marketplace -tAc "SELECT count(*) FROM ${table};" | tr -d '\r')
  status="OK"
  [ "$live" != "$restored" ] && status="MISMATCH"
  printf "%-14s live=%-8s restored=%-8s %s\n" "$table" "$live" "$restored" "$status"
done

echo "--- drill complete, tearing down now ---"
