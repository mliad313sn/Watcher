# Watcher — market-readiness checklist

Owned by the Product Owner. The autonomous release loop works this list top
to bottom; an item is checked only when implemented AND verified against the
running product. When every box is checked, the PO declares the product
ready to market with a final release report.

## Remaining

- [x] **R1 — Security review of the new surfaces.** Adversarial pass over
  SSO (state handling, JIT provisioning, role mapping), API tokens
  (hashing, scoping, timing), ingest endpoints (injection, tenant
  isolation, abuse limits), channel configs (secret handling in
  alert_rules), config import (SQL/regex injection). Fix what's found.
- [x] **R2 — Abuse hardening on ingest.** Rate limiting on
  /api/ingest/* and /api/metrics/ingest so a runaway integration cannot
  flood the alert table; verified with a burst test.
- [x] **R3 — Performance sanity.** Measure p50/p95 latency on the hot
  endpoints (/api/nagios/state, /api/alerts, dashboard payload) under
  concurrent load with the demo fleet; document numbers; fix anything
  pathological.
- [x] **R4 — Version 1.0.0-rc.1.** Bump workspace versions, write
  CHANGELOG.md summarizing all release waves, tag-worthy commit.
- [x] **R5 — Docs completeness pass.** README accuracy sweep against the
  shipped product; ensure INTEGRATIONS.md, install/service docs, and
  .env.example agree with the code; add an OPERATIONS.md (backup, upgrade,
  troubleshooting basics).
- [x] **R6 — Final full-stack verification + market-ready declaration.**
  All unit tests, integration smoke, ecosystem E2E, SSO E2E, anomaly E2E
  green on one run; live browser pass with zero console errors; publish
  the final release report (committee Session 05) and declare
  ready-to-market.

## Done (previous waves)

- [x] Core platform: Nagios engine integration, correlation with dependency
  suppression, live console, topology, reports, discovery, multi-tenancy
- [x] Incident stack: on-call rotations, escalation, runbooks, mobile ack,
  public status page, maintenance windows
- [x] Adoption: light/dark themes, ⌘K palette + actions, tour, bulk ack,
  assignment, saved views, PWA, accessibility pass
- [x] Enterprise: OIDC + LDAP SSO, scoped API tokens, SLA reports + CSV,
  config-as-code, service install (systemd + watcherd)
- [x] Intelligence: dynamic thresholds (median+MAD), LLDP auto-topology,
  OS agent + push ingest
- [x] Ecosystem: 12 outbound channels (Teams/Slack/PagerDuty/Opsgenie/
  ServiceNow/Jira/Discord/Telegram/Google Chat/SMTP/webhook), Alertmanager
  + generic inbound, Prometheus exposition, test-channel, INTEGRATIONS.md
