#!/usr/bin/env bash
# Install Watcher as a system service and launch it.
#
#   sudo bash scripts/install-service.sh [--home /opt/watcher]
#
# On a host with an active systemd: installs the unit files from
# infra/systemd/, creates the watcher user + /etc/watcher/watcher.env,
# enables and starts everything.
# On hosts without usable systemd (containers, minimal images): installs the
# `watcherd` supervisor to /usr/local/bin with the same lifecycle verbs and
# starts the services under it.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WATCHER_HOME="${WATCHER_HOME:-$REPO_DIR}"
[ "${1:-}" = "--home" ] && WATCHER_HOME="$2"

echo "── Watcher service install ─────────────────────────"
echo "   home: $WATCHER_HOME"

# 1) Config: /etc/watcher/watcher.env (never overwrite an existing one).
mkdir -p /etc/watcher
if [ ! -f /etc/watcher/watcher.env ]; then
  if [ -f "$REPO_DIR/.env" ]; then
    cp "$REPO_DIR/.env" /etc/watcher/watcher.env
  else
    cp "$REPO_DIR/.env.example" /etc/watcher/watcher.env
    echo "   NOTE: /etc/watcher/watcher.env created from .env.example — review it."
  fi
  # The service serves the built UI itself unless overridden.
  grep -q '^WEB_DIST=' /etc/watcher/watcher.env || echo "WEB_DIST=$WATCHER_HOME/apps/web/dist" >> /etc/watcher/watcher.env
fi
chmod 600 /etc/watcher/watcher.env

# 2) Build the UI if it isn't built yet.
if [ ! -f "$WATCHER_HOME/apps/web/dist/index.html" ]; then
  echo "   building web UI…"
  (cd "$WATCHER_HOME" && npm run build --workspace apps/web >/dev/null)
fi

# 3) systemd path or watcherd fallback.
if command -v systemctl >/dev/null 2>&1 && [ "$(systemctl is-system-running 2>/dev/null || true)" != "offline" ] \
   && systemctl list-units >/dev/null 2>&1; then
  echo "   init: systemd (active)"
  id -u watcher >/dev/null 2>&1 || useradd --system --home "$WATCHER_HOME" --shell /usr/sbin/nologin watcher
  # Units reference /opt/watcher; link it to the actual home.
  [ -e /opt/watcher ] || ln -s "$WATCHER_HOME" /opt/watcher
  install -m 644 "$REPO_DIR"/infra/systemd/watcher-api.service /etc/systemd/system/
  install -m 644 "$REPO_DIR"/infra/systemd/watcher-poller.service /etc/systemd/system/
  install -m 644 "$REPO_DIR"/infra/systemd/watcher.target /etc/systemd/system/
  # Agent only where an agent.env exists (it needs a per-host token).
  [ -f /etc/watcher/agent.env ] && install -m 644 "$REPO_DIR"/infra/systemd/watcher-agent.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now watcher-api.service watcher-poller.service
  [ -f /etc/watcher/agent.env ] && systemctl enable --now watcher-agent.service
  systemctl --no-pager --lines 0 status watcher-api watcher-poller || true
else
  echo "   init: no active systemd → installing watcherd supervisor"
  install -m 755 "$REPO_DIR/scripts/watcherd" /usr/local/bin/watcherd
  # Persist the home for the supervisor.
  grep -q '^WATCHER_HOME=' /etc/watcher/watcher.env || echo "WATCHER_HOME=$WATCHER_HOME" >> /etc/watcher/watcher.env
  WATCHER_HOME="$WATCHER_HOME" /usr/local/bin/watcherd start
  /usr/local/bin/watcherd status
fi

echo "── installed. Manage with: systemctl … watcher-api|watcher-poller"
echo "   (or: watcherd start|stop|restart|status|logs on non-systemd hosts)"
