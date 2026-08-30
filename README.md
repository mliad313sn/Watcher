# Watcher

Enterprise-grade network & systems monitoring platform. Nagios Core provides the
battle-tested check engine; Watcher wraps it in a modern, high-throughput
middleware layer and a fast, ergonomic multi-page dashboard UI.

**The incident stack is in the box** — dependency root-cause correlation,
on-call rotations with acknowledgement-SLA escalation, runbooks attached to
alerts, one-tap mobile acknowledge (no app), maintenance windows, a public
status page, SLA reports with CSV export, and native Slack / Microsoft Teams /
PagerDuty / webhook notification channels. Enterprise access: OIDC + LDAP SSO
with group→role mapping, scoped API tokens, multi-tenancy. Config-as-code:
export the whole monitoring configuration as one JSON bundle and import it
idempotently on any install. Fully self-hosted and air-gap friendly (vendored
fonts, no CDN, no phone-home).

Also in the box: **dynamic thresholds** (deterministic median+MAD anomaly
detection that explains every alert it raises), **LLDP auto-topology** (the L2
map builds itself from what switches report), a **zero-dependency OS agent**
(`apps/agent/watcher-agent.mjs` — pushes CPU/mem/disk/load with a scoped API
token), a push **metrics ingest API** for any integration, and an
**installable PWA** so the console lives on a phone home screen.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                              Browser (MPA)                                 │
│   dashboard · devices · alerts · topology · reports · settings · login     │
│           REST (fetch)  ▲                ▲  WebSocket (live events)        │
└─────────────────────────┼────────────────┼────────────────────────────────┘
                          │                │
┌─────────────────────────┴────────────────┴────────────────────────────────┐
│                        apps/api — Fastify middleware                       │
│  auth/RBAC · devices · alerts · metrics · dashboards · discovery · nagios  │
│      │              │                │                    │                │
│      ▼              ▼                ▼                    ▼                │
│  PostgreSQL      Redis          TimescaleDB        Nagios Core             │
│  (config,     (state cache,    (multi-year        (plugin execution,      │
│   tenants,     pub/sub,         metrics,           scheduling,            │
│   RBAC,        correlation)     hypertables)       state machine)         │
│   alerts)                                                                  │
└────────────────────────────────────────────────────────────────────────────┘
                          ▲
┌─────────────────────────┴──────────────────────────────────────────────────┐
│                     apps/poller — connector workers                        │
│   SNMP v1/v2c/v3 · WinRM/WMI · Meraki REST · Asterisk AMI · discovery      │
│         (metrics → TimescaleDB, live state → Redis pub/sub)                │
└────────────────────────────────────────────────────────────────────────────┘
```

## Repository layout

```
watcher/
├── apps/
│   ├── api/            Fastify REST + WebSocket middleware
│   │   └── src/
│   │       ├── plugins/        env, postgres, timescale, redis, auth, websocket
│   │       └── modules/
│   │           ├── nagios/     status.dat parser, external commands, Redis streamer
│   │           ├── alerts/     severity mapping, correlation & dependency suppression
│   │           ├── metrics/    TimescaleDB query/ingest API
│   │           ├── devices/    inventory CRUD
│   │           ├── discovery/  L2/L3 discovery framework
│   │           ├── dashboards/ widget layout persistence
│   │           └── auth/       JWT login, RBAC guard
│   ├── poller/         Connector workers (SNMP, Meraki, WinRM, Asterisk)
│   └── web/            Multi-page frontend (Vite MPA, no SPA framework required)
│       └── pages: index, devices, device, alerts, topology, reports, settings, login
├── packages/
│   ├── shared/         Severity model, Nagios state mapping, shared utils
│   └── ui/             Widget library: gauges, heatmaps, traffic graphs, grids
├── infra/
│   ├── nagios/         Nagios Core Dockerfile + example object configuration
│   └── sql/
│       ├── postgres/   Config-plane schema (tenants, users, devices, alerts…)
│       └── timescale/  Metrics hypertables, continuous aggregates, retention
└── docker-compose.yml  Full local stack
```

## Design decisions

### Nagios Core as the check engine
Nagios owns scheduling, plugin execution, retries, flap detection and the
host/service state machine. Watcher never re-implements checks — it *reads*
Nagios state and *writes* external commands (acknowledge, downtime, re-check).

Integration path (in order of preference, auto-detected at runtime):

1. **mk-livestatus socket** (`NAGIOS_LIVESTATUS_SOCKET`) — query-based, low latency.
2. **status.dat polling** (`NAGIOS_STATUS_FILE`) — zero-dependency default. The
   connector watches the file mtime, parses it incrementally, diffs against the
   Redis state cache, and publishes only *changes* to `watcher:events:state`.

Writes go through the external command file (`NAGIOS_COMMAND_FILE`), the same
named pipe the Nagios CGIs use — so Watcher stays a well-behaved citizen next
to any existing Nagios tooling.

### Redis as the real-time plane
- `watcher:state:host:<name>` / `watcher:state:svc:<host>/<svc>` — current state hashes.
- `watcher:events:state` — pub/sub channel of state-change events (JSON).
- `watcher:events:alerts` — correlated, deduplicated alert stream for the UI.
- Poller rate computations (SNMP counter deltas) keep their previous sample in Redis.

The API's WebSocket hub subscribes once per process and fans out to browser
clients, so a state change reaches every open dashboard in one hop.

### TimescaleDB for metrics
A single narrow hypertable (`metrics`) partitioned by time + hashed device,
with native compression after 7 days, tiered continuous aggregates
(5-minute → 1-hour → 1-day) and multi-year retention on the aggregates only.
This is the standard Timescale pattern for "massive volume, long history,
fast dashboard rollups".

### PostgreSQL for the config plane
Tenants, users, roles, devices, credentials, dashboards/widgets, alert rules,
discovery jobs, and the durable alert log. Kept separate from TimescaleDB so
the metrics cluster can be scaled/retained independently.

### Multi-page frontend
Each functional area is its own HTML page with its own entry module — a real
MPA. Shared chrome (sidebar, topbar, theme) and the widget library live in
`packages/ui` as dependency-free Web Components (SVG rendering, no chart
library). Pages stay small, load fast, and can be cached/CDN'd individually.
Dashboards support drag-and-drop widget layout persisted per user via the API.

### Alerting engine
`apps/api/src/modules/alerts/correlation-engine.js` consumes the state stream:
- Maps Nagios states → severities (Critical / Warning / Info + Clear).
- **Dependency suppression**: children of a DOWN parent (from the topology
  graph) produce suppressed alerts instead of pages — no alert storms.
- **Deduplication**: one open alert per (device, check); repeats bump a counter.
- **Flap damping**: rapid state oscillation folds into a single flapping alert.

## Quick start

### Run the whole product (Docker)

```bash
cp .env.example .env
docker compose up -d --build     # nagios, redis, postgres, timescaledb, api, poller, web
```

Open **http://localhost:8088** — the `web` service serves the built UI and
reverse-proxies `/api` and `/ws` to the API, so the entire platform is reachable
from one origin (no CORS, no dev proxy). The API is also exposed directly on
`:8080` and Nagios on `:8081`.

First run shows an empty-state prompt to **load the demo environment** (a
13-device fleet with live-looking metrics, alerts, on-call rotation, runbooks
and status components) so you can explore before wiring real monitoring.

### Develop (hot reload)

```bash
cp .env.example .env
docker compose up -d redis postgres timescaledb nagios
npm install
npm run dev:api               # Fastify on :8080
npm run dev:web               # Vite MPA on :5173  ← open this in dev
npm run dev:poller            # connectors
```

### Single-origin without nginx

The API can serve the built UI itself — set `WEB_DIST` to the built bundle and
everything answers on `:8080`:

```bash
npm run build --workspace apps/web
WEB_DIST=$PWD/apps/web/dist npm run dev:api   # UI + API on :8080
```

Default login (seeded by `infra/sql/postgres/002_seed.sql`): `admin` / `admin`
— change immediately.
