# Changelog

## 1.1.0-rc.1 — the collection release

Watcher could poll. It could not *receive*. This release closes the five
gaps that separated it from the platforms it competes with, and every one of
them is a thing a device or a network does that polling cannot see.

The design decision under all five: **there is one alert model in this
product.** A trap, a syslog line, a remote site's check and a configuration
drift all become a state change on `watcher:events:state` — the channel the
Nagios streamer already wrote — so correlation, dependency suppression,
maintenance windows, on-call, runbooks and ack-SLA escalation apply to every
one of them without those modules learning that any of it exists.

### Event plane — SNMP traps and syslog
- Trap receiver: v1, v2c, v3 and informs. v1 identity is translated to its
  v2c OID (RFC 3584 §3.1) so one rule set covers both wire formats.
  Authorisation is always on — no community and no v3 user configured
  rejects every trap rather than standing up an open alert-injection port.
- Syslog receiver: RFC 3164 and RFC 5424, UDP and TCP, both RFC 6587
  framings, bounded queue with visible load shedding.
- An ordered rule engine (first match wins, because "why did this page me"
  deserves one rule to read). OID selectors match on label boundaries —
  `1.3.6.1.4.1.9` must not also select `1.3.6.1.4.1.99` and page the wrong
  team.
- An event has no OK to come back to, so a raising rule must say how what it
  raised ends: a paired clearing rule rendering the same check name, or an
  auto-clear deadline refreshed on recurrence.
- An event from an address in neither inventory nor the allow-list is stored
  and shown but can never raise. Syslog over UDP is spoofable and a v2c
  community crosses in clear.
- Per-source admission control at 200/min, with one notice when it engages —
  a silent throttle is indistinguishable from a device that went quiet.
- Volume bounded in the schema: compression at two days, retention at
  thirty, and an hourly per-sender rollup kept two years.

### Flow analytics — NetFlow v5/v9, IPFIX, sFlow
- Four formats on one UDP port, one normalised record.
- Folded at ingest into conversations, because a busy edge router exports
  tens of thousands a minute and one row each is a write path that fails on
  the first real link. Direction normalised, ephemeral ports dropped.
- Past the ceiling the remainder folds into one `(other)` row: the detail is
  lost, the totals stay true.
- Templates cached per exporter *and* observation domain; data arriving
  before its template is counted as pending rather than dropped.
- sFlow samples scaled by the agent's sampling rate.
- What it costs is documented rather than discovered: no per-session
  forensics.

### Distributed polling — remote site proxies
- A proxy at the site, polling locally, pushing over one outbound HTTPS
  connection. No inbound rule, no VPN, no database credential at the site.
- Enrolment is one-time and burned inside the statement that issues the
  durable credential, so two proxies racing one secret produce one winner.
- Device credentials never leave the centre: an assignment carries a
  credential's *name*, and the secret lives in the proxy's own file.
- Store-and-forward committed only on acknowledgement, bounded, dropping the
  **oldest** first — after a long outage the site's current state matters,
  not a replay of Tuesday. Retries use full jitter.
- Proxy silence is a critical alert naming how many devices stopped being
  monitored. A site nothing is checking otherwise looks healthy, which is
  what makes distributed monitoring worse than none at all when it is
  trusted.

### Configuration backup and drift
- Nightly capture over the system `ssh` (network gear is where SSH
  implementations go to be strange; OpenSSH can be told to accept what a
  bundled library cannot). Seven vendor profiles.
- A version is stored only when the *normalised* config changed. Vendor
  noise — `ntp clock-period`, `! Last configuration change at …` — is not a
  change, and a drift alert that fires every night is one nobody reads.
- Secrets redacted before storage, with an optional keyed fingerprint so a
  rotation is still visible without the value ever being stored or becoming
  an offline guessing target.
- Drift means differing from what somebody **approved**, not from last
  night. A device with no baseline is not drifting.
- An empty capture is refused rather than stored — it would read as a device
  whose entire configuration was deleted.

### Console
New Events, Traffic and Configs pages; a rule dry-run that answers "what
would this event do?" against the live rule set without storing anything or
paging anyone.

### Verified
278 tests, all passing (was 74). Notably: 34 syslog grammar and TCP framing
cases, 40 flow-format cases against datagrams built byte by byte to spec, 12
real-socket end-to-end tests through the event pipeline to the published
state event, and 38 covering the proxy buffer, backoff and staleness
boundaries.

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
