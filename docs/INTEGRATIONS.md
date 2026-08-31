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
