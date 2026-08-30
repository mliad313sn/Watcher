#!/usr/bin/env bash
# Local launch of the whole Watcher stack (no docker): Redis + Postgres (config
# plane) + a plain-PG metrics DB + the API serving the built web UI at one
# origin. Idempotent — safe to re-run.
set -u
PGBIN=/usr/lib/postgresql/16/bin
export PGDATA=/tmp/wpg
export PGPORT=55432

echo "── Redis ─────────────────────────────────────────"
redis-cli ping >/dev/null 2>&1 || redis-server --daemonize yes --save "" --appendonly no
sleep 1; redis-cli ping

echo "── Postgres ──────────────────────────────────────"
if ! su postgres -c "$PGBIN/pg_ctl -D $PGDATA status" >/dev/null 2>&1; then
  # Data dir may exist from a prior run; only initdb when truly absent.
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    rm -rf "$PGDATA"; mkdir -p "$PGDATA"; chown postgres:postgres "$PGDATA"
    su postgres -c "$PGBIN/initdb -D $PGDATA -A trust" >/dev/null
  fi
  su postgres -c "$PGBIN/pg_ctl -D $PGDATA -o '-p $PGPORT -k /tmp' -l /tmp/pg.log -w start"
fi
su postgres -c "$PGBIN/pg_ctl -D $PGDATA status" | head -1
