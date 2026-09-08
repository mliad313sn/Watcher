# Watcher integrations

Watcher interconnects in both directions: it **pages into** every major
chat/ITSM/incident platform, and it **feeds and receives** the observability
ecosystem. Channels attach to alert rules as `actions` (Admin → alert rules,
or config-as-code); every channel can be verified end-to-end with
`POST /api/alerts/test-channel {"action": {...}}` before you rely on it.

## Microsoft ecosystem

| Surface | How |
|---|---|
| **Teams (Power Automate / Workflows)** | `{"type":"teams","card":"adaptive","url":"<workflow HTTP URL>"}` — Adaptive Card with facts + Acknowledge/Runbook buttons. `logic.azure.com` URLs auto-select the Adaptive format. |
| **Teams (legacy incoming webhook)** | `{"type":"teams","url":"<webhook>"}` — MessageCard. |
| **Entra ID sign-on** | OIDC SSO: `SSO_OIDC_ISSUER=https://login.microsoftonline.com/<tenant>/v2.0` + app registration; map groups with `SSO_ROLE_MAP`. |
| **Microsoft 365 mail** | `{"type":"email","to":"noc@…"}` with `SMTP_HOST=smtp.office365.com SMTP_PORT=587 SMTP_USER=… SMTP_PASSWORD=…`. |
| **Power Automate (inbound to Watcher)** | Any flow can raise/resolve Watcher alerts: `POST /api/ingest/event` with an `X-API-Token`. |
| **Excel / Power BI** | Fleet SLA CSV export (`/api/metrics/sla?format=csv`) and the JSON API. |

## Incident & ITSM

| Platform | Action config |
|---|---|
| **PagerDuty** | `{"type":"pagerduty","routingKey":"<Events v2 key>"}` — deduped per alert; |
| **Opsgenie** | `{"type":"opsgenie","apiKey":"<GenieKey>"}` — aliased per alert, auto-closes on recovery. |
| **ServiceNow** | `{"type":"servicenow","url":"https://<instance>.service-now.com","user":"…","password":"…"}` — incident via Table API, `correlation_id` for SN workflows. |
| **Jira** | `{"type":"jira","url":"https://<site>.atlassian.net","projectKey":"OPS","email":"…","apiToken":"…"}` (or `bearer` for DC PATs). |

## Chat

| Platform | Action config |
|---|---|
| **Slack** | `{"type":"slack","url":"<incoming webhook>"}` |
| **Discord** | `{"type":"discord","url":"<webhook>"}` — severity-coloured embed. |
| **Telegram** | `{"type":"telegram","botToken":"…","chatId":"…"}` |
| **Google Chat** | `{"type":"googlechat","url":"<space webhook>"}` — cardsV2 with buttons. |
| **Anything else** | `{"type":"webhook","url":"…"}` — full JSON payload (title, alert, ackUrl, runbook). Works with Mattermost, Rocket.Chat, Zapier, Make, n8n. |

## Email

`{"type":"email","to":"noc@example.org"}` — native SMTP via `SMTP_HOST/PORT/
SECURE/USER/PASSWORD/FROM` env (per-action `smtp:{...}` overrides), HTML +
plain-text with a one-tap Acknowledge button. A legacy `gatewayUrl` webhook
relay is still supported.

## Observability ecosystem

**Watcher as a data source**
- `GET /metrics` — Prometheus exposition of Watcher itself (alerts by
  severity, devices monitored, process health). Scrape it like any exporter.
- `GET /api/metrics/prometheus` — the whole fleet's latest gauges as
  `watcher_fleet_metric{device,metric,instance}`. Point a Prometheus scrape
  job (custom header `X-API-Token: <viewer token>`) at it and the estate
  lands in Grafana.

**Watcher as an alert hub**
- `POST /api/ingest/alertmanager` — native Prometheus Alertmanager
  `webhook_config` receiver. Firing alerts open in the correlation center
  (on-call, runbooks, maintenance windows all apply); resolved closes them.
  ```yaml
  receivers:
    - name: watcher
      webhook_configs:
        - url: https://watcher.example/api/ingest/alertmanager
          http_config:
            headers: { X-API-Token: <operator token> }
  ```
- `POST /api/ingest/event` — generic raise/resolve for scripts and automation
  platforms: `{"device","check","severity","message","status"}`.
- `POST /api/metrics/ingest` — push metrics from anything (the OS agent uses
  this).

## Device-originated events

Traps and syslog are the half of monitoring that polling cannot see: what
happened *between* two polls. Both receivers live in the poller and are off
until given a port.

| Surface | How |
|---|---|
| **SNMP traps (v1, v2c, v3)** | `TRAP_PORT=162` plus `TRAP_COMMUNITIES` and/or `TRAP_V3_USERS`. Informs are acknowledged. v1 traps are translated to their v2c OID (RFC 3584) so one rule set covers both. |
| **Syslog (RFC 3164 + RFC 5424)** | `SYSLOG_PORT=514`, UDP and TCP; TCP reads both RFC 6587 framings. |
| **Rule engine** | OID / regex / facility / severity selectors → raise, clear, drop or log. `POST /api/events/test` dry-runs the live rule set. |
| **Search** | `GET /api/events?q=…&source=…&maxSeverity=3` |

Events enter the **same** alert pipeline as Nagios checks, so correlation,
maintenance windows, on-call and runbooks all apply unchanged. Full
documentation: [docs/EVENTS.md](EVENTS.md).

## Flow analytics

| Surface | How |
|---|---|
| **NetFlow v5** | `FLOW_PORT=2055`; fixed layout, no templates. |
| **NetFlow v9** | Templates cached per exporter and observation domain. |
| **IPFIX** | RFC 7011, including 64-bit counters, variable-length and enterprise elements. |
| **sFlow v5** | Flow samples decoded from the sampled frame and scaled by the agent's rate. |

All four arrive on one UDP port and fold into conversations at ingest.
Full documentation: [docs/FLOW.md](FLOW.md).

## Remote sites

| Surface | How |
|---|---|
| **Proxy poller** | `WATCHER_PROXY_URL` on a poller at the site; one-time enrolment, then outbound HTTPS only. |
| **Store-and-forward** | Observations are buffered across a WAN outage and committed only on the server's acknowledgement. |
| **Silence watchdog** | A proxy that stops reporting raises a critical alert naming the devices that stopped being monitored. |

Device credentials stay at the site — an assignment names a credential, it
never carries one. Full documentation: [docs/PROXIES.md](PROXIES.md).

## Configuration management

| Surface | How |
|---|---|
| **Config backup** | `CONFIG_BACKUP=1`; nightly capture over the system `ssh` with key auth. |
| **Vendors** | Cisco IOS/IOS-XE and NX-OS, Juniper, Arista, HP/Aruba, MikroTik, FortiOS, generic. |
| **Drift** | Alerts when a device stops matching an *approved* baseline — not merely last night's capture. |
| **Diffs** | `GET /api/configs/:deviceId/diff` against the baseline or any two versions. |

Secrets are redacted before storage. Full documentation:
[docs/CONFIGS.md](CONFIGS.md).

## Identity

- **OIDC**: Keycloak, Authentik, Okta, Entra ID, Google — `SSO_OIDC_*` env,
  group→role mapping, JIT provisioning.
- **LDAP / Active Directory**: `SSO_LDAP_*` env, bind-through auth,
  memberOf→role mapping.

## Automation & GitOps

- **Scoped API tokens** (Admin → API tokens): every API above accepts
  `X-API-Token`.
- **Config-as-code**: `GET /api/config/export` → one JSON bundle (devices,
  rules with all channel actions, runbooks, on-call, status components);
  `POST /api/config/import` applies it idempotently (`dryRun` supported).
  Keep the bundle in Git; promote between installs.
