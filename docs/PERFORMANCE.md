# Performance baseline (R3)

Measured against the running product (single API process, watcherd-managed,
demo fleet of 13 devices / 15 services seeded, all four engines live) with a
20-worker concurrent closed-loop harness, 8 s per endpoint, on a small shared
sandbox VM. Numbers are a floor, not a ceiling — production hardware and
Node's cluster mode only improve them.

| Endpoint | Purpose | req/s | p50 | p95 | p99 |
|---|---|---:|---:|---:|---:|
| `/api/nagios/state` | full live state (Redis fan-in) | 2,034 | 8.8 ms | 17.7 ms | 25.3 ms |
| `/api/nagios/summary` | status tiles | 3,820 | 4.7 ms | 8.5 ms | 11.3 ms |
| `/api/alerts` | correlation center list | 3,473 | 5.3 ms | 9.7 ms | 12.9 ms |
| `/api/nagios/events/recent` | feed backfill (2-table merge) | 2,238 | 8.6 ms | 12.8 ms | 16.0 ms |
| `/api/metrics/sla?days=7` | fleet SLA (heaviest read) | 2,561 | 7.4 ms | 11.7 ms | 15.8 ms |
| `/api/devices/topology/graph` | topology graph | 3,255 | 5.6 ms | 10.3 ms | 13.2 ms |
| `/` | console page (static, single-origin) | 4,939 | 3.4 ms | 7.7 ms | 12.0 ms |

**Zero 5xx across 178,570 requests. Worst p95: 17.7 ms.**

Acceptance bar for this checklist item was p95 < 500 ms with no errors —
passed with ~28× headroom. No endpoint showed pathological behaviour; no
fixes required.

Notes for larger estates:
- `/api/nagios/state` cost scales with object count (one Redis HGETALL per
  object, pipelined). At ~10k objects, expect the UI to lean on the
  WebSocket diff stream (already the design) rather than full re-reads.
- `/api/metrics/sla` runs two queries regardless of fleet size (bulk
  window + bulk prior-state) — by design, not N+1.
- Rate limits (R2) bound ingest write pressure per principal.

Harness: 20 concurrent workers per endpoint, sequential endpoint sweep,
latency includes full body download. Re-run: `node /tmp/loadtest.mjs`
(script in repo history / trivially reproduced from this table's method).
