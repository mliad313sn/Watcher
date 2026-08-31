# Changelog

## 1.0.0-rc.1 — first release candidate

Everything below shipped in verified waves, each driven by a committee
session (published under `docs/committee/`) and proven against the running
product before merge. 74+ unit tests, integration smoke, and five dedicated
E2E suites (SSO, anomaly, ecosystem, security, load) guard the release.

### Core platform
- Nagios Core as the check engine: status.dat streamer (mtime-watch,
  incremental parse, change-diff to Redis), external command writer
  (ack / recheck / downtime), engine-staleness self-alerting.
- Dependency-aware correlation: automatic root-cause detection with child
  suppression (recursive topology CTE), dedup per (device, check),
  flap damping, retro-suppression, atomic race-safe raises.
- Live console: multi-page app (no SPA framework), WebSocket event fan-out
  with tenant filtering and backpressure, live topology map, correlation
  center, device inventory, discovery jobs, per-user dashboards.
- Multi-tenancy end to end (state cache, WebSocket, metrics, actions).

### Incident stack (in the box)
- On-call schedules with automatic rotation and overrides.
- Acknowledgement-SLA escalation (unacked criticals escalate; atomic claim).
- Runbooks attached to alerts by match rules, delivered in every page.
- One-tap mobile acknowledge via signed per-alert capability links (no app).
- Maintenance windows: planned work pages nobody, status page shows notice.
- Public status page: sanitized component rollup, unauthenticated.

### Enterprise
- SSO: OIDC authorization-code flow (Keycloak/Authentik/Okta/Entra/Google)
  + LDAP/AD bind auth; group→role mapping, JIT provisioning,
  deny-by-default; local accounts can never be claimed via the IdP.
- Scoped API tokens (SHA-256 at rest, shown once, role-capped, expiring).
- SLA availability reports for the whole fleet with CSV export.
- Config-as-code: full-config JSON export / idempotent transactional import
  with dry-run.
- Service install: hardened systemd units + `watcherd` supervisor fallback
  (same lifecycle, auto-restart) via one installer script; docker-compose
  topology with single-origin nginx `web` service.

### Intelligence
- Dynamic thresholds: deterministic median+MAD baselines per device+metric;
  explainable anomaly alerts ("+17.7σ above its 7-day normal"), auto-resolve.
- LLDP auto-topology: the L2 link map builds itself from switch neighbor
  tables (hourly sweep, canonical edges, inventory name matching).
- Zero-dependency OS agent (`apps/agent`) pushing CPU/mem/disk/load via the
  push metrics ingest API with a scoped token.

### Ecosystem
- Outbound channels (all pure, unit-tested wire formats): Microsoft Teams
  Adaptive Cards (Power Automate) + legacy MessageCard, Slack, PagerDuty
  (Events v2, deduped), Opsgenie (aliased, auto-close), ServiceNow
  incidents, Jira issues, Discord, Telegram, Google Chat, native SMTP
  email (M365/Gmail/any), generic webhook. Every page carries the ack link
  and matched runbook. `POST /api/alerts/test-channel` verifies any channel
  through the real path.
- Inbound: Prometheus Alertmanager receiver and generic event API — external
  alerts get full citizenship (correlation, on-call, runbooks, maintenance).
- Observability citizenship: Prometheus exposition for Watcher itself
  (`/metrics`) and a fleet gauge exporter for Grafana.

### Experience
- Light + dark themes (system-following, persisted toggle, no-flash).
- ⌘K command palette: pages, live devices, runnable actions; vim-style
  g-navigation; "?" shortcut sheet.
- Guided first-run tour anchored to live panels; demo environment seeded in
  one click; live event feed primed with history.
- Bulk acknowledge, alert assignment ("Take"), saved filter views,
  relative timestamps, topology legend, toast feedback everywhere.
- Installable PWA; WCAG touches (skip link, focus-visible, aria labels,
  reduced motion).

### Hardening & operations
- Security review (docs/SECURITY-REVIEW.md): SSO local-account-takeover
  path closed, channel secrets redacted from read APIs; accepted-surface
  documentation.
- Per-principal rate limits on all ingest surfaces (429 + Retry-After,
  fail-open on Redis loss).
- Event-bus subscribers drop malformed messages instead of crashing;
  streamer never mass-evicts on an empty engine parse.
- Performance baseline (docs/PERFORMANCE.md): worst p95 17.7 ms at 20-way
  concurrency, zero errors across 178k requests.
