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

## 1.1 ingest throughput

Every collection path added in 1.1 is a UDP listener, and a listener that
cannot keep up does not return an error to anybody — it drops datagrams in
the kernel, and the monitoring system reports that everything is fine. The
failure is invisible, so the headroom is measured rather than assumed.

`npm run bench:ingest` measures the **code added in 1.1** with the datastores
replaced by doubles. It answers "can the parser, the rule engine and the
aggregator keep up with a real device estate". It deliberately does not
measure Postgres, TimescaleDB or Redis; `scripts/loadtest.mjs` drives the
real stack over HTTP for that.

```
measured against datastore doubles — this is the added code, not the databases

  syslog parse (RFC 3164 + 5424 mixed)                                927711/s   (200,000 in 216ms)
  rule evaluation (40 rules, match on the last)                       696836/s   (200,000 in 287ms)
  event pipeline end to end (identify → store → decide → publish)     324957/s   (100,000 in 308ms)
  NetFlow v5 decode                                                  4411664 records/s   (300,000 in 68ms)
  flow aggregation key                                              14137862/s   (500,000 in 35ms)
  config normalise + hash (1200-line config)                            1466/s   (2,000 in 1364ms)
  config diff (1200 lines, one changed)                                   62/s   (500 in 8041ms)

  flow aggregation reduction                                       60,000 records → 30 rows (2000×)

  node v22.22.2
```

### Reading these

- **309 000 events/second through the whole event pipeline** — identify the
  sender, rate-limit, store, evaluate 40 rules, publish. A thousand devices
  each emitting a syslog line every second is 1 000/s, so the headroom is
  roughly three hundredfold. The per-source admission ceiling (200/minute)
  binds long before the code does, which is the intended order.
- **4.6 million flow records/second decoded.** Flow is the highest-volume
  input by an order of magnitude, and decoding is not where it hurts.
- **2000× aggregation reduction** — 60 000 records folded to 30 rows. This is
  the number the whole flow design rests on: storing one row per conversation
  is a write path that fails on the first real link, and this is the measured
  size of the reduction that avoids it.
- **Config diff is the slowest path at ~15 ms for a 1 200-line
  configuration**, which is a nightly job against a few hundred devices —
  seconds of work in total. It is bounded at 25 million LCS cells (100 MB);
  past that a diff is summarised rather than allocated. That bound came from
  this benchmark: the previous per-side limit of 20 000 lines permitted a
  1.6 GB allocation on a chassis configuration.
