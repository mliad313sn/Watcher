# Where Watcher 1.1 actually stands

Written as a committee statement rather than a marketing one, because a
product team that believes its own marketing stops fixing things.

**Watcher is not "the best monitoring platform on the market."** No
self-hosted product at this size is, and a team claiming it would be telling
you something you could check in an afternoon. What 1.1 did is close the five
gaps that made the claim *impossible to argue* — and that is a different,
verifiable statement.

---

## What changed

Before 1.1, Watcher could **poll**. It could not **receive**. Against any
platform in its category that was not a feature gap, it was a category gap:
a network monitoring product that cannot take a trap is not competing, it is
demoing.

| | Before | Now |
|---|---|---|
| SNMP traps | — | v1, v2c, v3, informs, RFC 3584 translation |
| Syslog | — | RFC 3164 + 5424, UDP + TCP, both RFC 6587 framings |
| Flow analytics | — | NetFlow v5/v9, IPFIX, sFlow |
| Distributed polling | — | Remote-site proxies, outbound-only |
| Config backup & drift | — | Seven vendor profiles, approved baselines |
| Upgradeable | **no** | `npm run migrate` |

That last row was the quietest and the most serious: until 1.1 there was no
migration runner, so an existing install could not be upgraded at all.

## Honestly, against the field

**Zabbix** — the closest comparison, and the fairest. Zabbix has more
templates, more years, more community, and a proven proxy fleet at scale.
Watcher now matches its *architecture* on the points that matter (event
plane, proxies, one alert model) and does not match its ecosystem. Choose
Zabbix if template breadth decides; choose Watcher if the incident stack
being in the box does.

**LibreNMS / Observium** — stronger auto-discovery and vendor coverage.
Watcher has better incident handling (on-call, ack-SLA escalation, runbooks,
dependency correlation) and a far better API.

**PRTG** — easier for a small estate, sensor-priced. Watcher has no licence
and no sensor count, and asks more of the operator.

**Datadog / New Relic** — a different product for a different budget. They
have APM, logs at scale, and machine learning Watcher has no answer to. They
also send your telemetry to somebody else's cloud and bill by the host.
Watcher is what you run when that is not acceptable or not affordable.

**SolarWinds** — NPM + NTA + NCM is three products and a substantial licence.
1.1 is the release where the equivalent capability is in one self-hosted
product with no licence. It is not as polished. It is auditable, and it is
free.

**Nagios XI** — Watcher *uses* Nagios Core as its check engine and puts a
modern platform around it. If you already run Nagios, this is the shortest
path to the rest.

**Grafana + Prometheus** — a superb metrics stack and not a network
monitoring product. Watcher speaks Prometheus in both directions
(`/metrics`, an Alertmanager receiver, and fleet exposition) precisely
because the answer is often "both".

## What Watcher genuinely does better than most

1. **One alert model.** A trap, a syslog line, a remote site's check, a
   config drift and a Nagios check all become the same state change, so
   correlation, maintenance windows, on-call and runbooks apply to every one
   of them without configuration. Most platforms bolt event handling on
   beside alerting and end with two consoles.
2. **The incident stack is in the box** — dependency root-cause correlation,
   on-call rotation, ack-SLA escalation, runbooks on alerts, one-tap mobile
   ack, maintenance windows, a public status page. Elsewhere this is
   PagerDuty plus Statuspage plus a wiki.
3. **Silence is loud.** A silent proxy raises a critical alert naming how
   many devices stopped being watched. A throttled event source says so. A
   failing config capture is flagged. The failure mode of monitoring is
   *looking fine*, and this product is unusually careful about it.
4. **Limits ship with features.** Retention, compression, admission control
   and aggregation ceilings are in the schema, not in a tuning guide.
5. **It is auditable in an afternoon.** 315 tests, a documented release
   review naming five defects found and fixed, and measured ingest
   throughput. Few commercial products will show you that.

## What it is not

- **Not proven at scale by anyone but us.** The ingest numbers are measured
  against datastore doubles; `scripts/loadtest.mjs` drives the real stack but
  not a thousand-device estate over a year.
- **Not a log platform.** Syslog is stored, searched and alerted on for 30
  days. It is not Loki or Elastic and does not pretend to be.
- **Not APM.** No tracing, no code-level visibility.
- **No vendor.** No support contract, no SLA, nobody on call.
- **No template library.** Zabbix has thousands; Watcher has connectors and
  an ingest API.

## What would move it furthest next

In the order a committee would fund them:

1. **A template/profile library** for common vendors — the single largest
   remaining gap against Zabbix and LibreNMS, and mostly content rather than
   engineering.
2. **HA for the platform itself.** Proxies survive the WAN; the centre is
   still one deployment.
3. **Log search at volume** — the syslog store is honest but bounded, and an
   estate that wants 90 days needs a different write path.
4. **Auto-discovery breadth** to match LibreNMS.
5. **A real estate running it for a year**, and the findings that come back.

---

*Watcher 1.1.0 · delivery committee · 8 September 2026. The five workstreams
behind this release were governed in Meridian under programme `WCH`; the
release review is in `docs/RELEASE-REVIEW-1.1.md` and the measured throughput
in `docs/PERFORMANCE.md`.*
