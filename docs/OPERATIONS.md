# Operating Watcher

Day-2 basics for the team running a Watcher installation. Assumes the service
install (`scripts/install-service.sh`) or docker-compose.

## Health

- **`GET /healthz`** — process liveness (cheap, no dependencies).
- **`GET /readyz`** — dependency truth: postgres, timescaledb, redis, and
  **nagios freshness** (503 + per-check detail when anything is wrong). Wire
  this into your load balancer / uptime checks; Watcher refuses to claim
  "ready" while monitoring is blind.
- **`GET /metrics`** — Prometheus exposition (active alerts by severity,
  devices monitored, process memory). Scrape it.
- `watcherd status` / `systemctl status watcher-api watcher-poller` — service
  state; logs in `/var/log/watcher/` or `journalctl -u watcher-api`.

## Backup & restore

Everything durable lives in the two Postgres databases; Redis is a
rebuildable cache.

```bash
# Backup (config plane + alert history, and metrics)
pg_dump -Fc watcher         > watcher-$(date +%F).dump
pg_dump -Fc watcher_metrics > watcher-metrics-$(date +%F).dump

# Restore
pg_restore -d watcher watcher-YYYY-MM-DD.dump
pg_restore -d watcher_metrics watcher-metrics-YYYY-MM-DD.dump
```

- Also back up **`/etc/watcher/watcher.env`** (secrets: JWT_SECRET,
  CRED_ENC_KEY, SMTP, SSO client secret). Losing `CRED_ENC_KEY` makes stored
  device credentials undecryptable; losing `JWT_SECRET` just logs everyone
  out.
- **Configuration-only backup / promotion**: `GET /api/config/export` gives a
  reviewable JSON bundle (devices, rules incl. channel secrets, runbooks,
  on-call, status components); `POST /api/config/import` applies it
  idempotently — keep it in Git.
- Redis needs no backup: live state repopulates from Nagios within one poll
  interval; the demo can be reseeded in one click.

## Upgrades

```bash
cd /path/to/watcher && git pull
npm ci
npm run build --workspace apps/web
for f in infra/sql/postgres/0*.sql; do psql -d watcher -f "$f"; done   # idempotent
watcherd restart            # or: systemctl restart watcher-api watcher-poller
curl -sf localhost:8080/readyz
```

Migrations are numbered and idempotent (`IF NOT EXISTS` / guarded); applying
the full directory is safe. Zero-downtime: run two API instances behind a
proxy and restart them in turn — engines coordinate through Postgres/Redis
(escalation and anomaly claims are atomic).

## Troubleshooting

| Symptom | Look at | Usual cause |
|---|---|---|
| `/readyz` says `nagios: stale` | Nagios engine, `NAGIOS_STATUS_FILE` path/mount | Engine down or file not shared with the API. Watcher raises a `__watcher__/nagios-engine` alert for this too. |
| Nobody got paged | `notification_log` table; Admin → test-channel | Rule didn't match (severity/kind), cooldown window, or an active **maintenance window** (channel `maintenance/suppressed` rows say so). |
| Alerts flood after an outage | Correlation is on by design | Check the parent links (topology) — children of a down parent should show `suppressed`. Missing parents = missing suppression. |
| 429 from ingest APIs | `X-RateLimit-*` headers | A runaway integration hit the per-principal limits (R2). Back off or split tokens per source. |
| SSO user can't log in | api log: `SSO login refused` | Group not in `SSO_ROLE_MAP` (deny-by-default) or the username belongs to a local account (takeover protection — rename one side). |
| Poller ignores a device | `poll_assignments` (enabled, credential_id) | No assignment or credential; `CRED_ENC_KEY` changed since the credential was stored. |
| UI stale after upgrade | `WEB_DIST` build | `npm run build --workspace apps/web` wasn't run; hard-refresh (hashed assets otherwise cache-bust automatically). |

## Routine tasks

- **Rotate an API token**: create the replacement in Admin → API tokens,
  switch the integration, revoke the old one (instant).
- **Planned work**: schedule a maintenance window (Admin) — matching pages
  are suppressed and the public status page shows the notice; cancel it to
  end early.
- **Monthly SLA report**: Reports → Fleet SLA → Export CSV
  (or `GET /api/metrics/sla?days=30&format=csv` from cron with a token).
- **Enroll a new host's OS metrics**: create an operator token, drop
  `/etc/watcher/agent.env` on the host, start `watcher-agent`
  (see infra/systemd/watcher-agent.service).
