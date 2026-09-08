# Flow analytics — NetFlow, IPFIX and sFlow

"Is it up?" is answered by a check. **"Why is the link full, and who is
filling it?"** is answered only by flow.

SolarWinds sells that answer as a separate product (NTA), Auvik puts it in a
higher tier, and a monitoring platform without it ends every bandwidth
conversation with a shrug. Watcher collects it in the poller, on one port,
from all four common export formats.

| Format | Version | Notes |
|---|---|---|
| NetFlow | v5 | Fixed layout, no templates. Still what most switches actually emit. |
| NetFlow | v9 | Template-based; templates cached per exporter **and** observation domain. |
| IPFIX | RFC 7011 | Including 64-bit counters, variable-length elements and enterprise elements. |
| sFlow | v5 | Flow samples; the sampled frame is decoded and scaled by the agent's sampling rate. |

All four reduce to one normalised record, so nothing above the decoder learns
which vendor exported what.

---

## Turning it on

```bash
# apps/poller
FLOW_PORT=2055
```

Then tell the routers where to send. 2055 is the convention for NetFlow and
IPFIX; sFlow's is 6343, and both are read on the same socket, so pick one
port and point everything at it.

```
! Cisco IOS
ip flow-export version 9
ip flow-export destination <watcher> 2055
interface GigabitEthernet0/1
 ip flow ingress

# Juniper (IPFIX), nftables/nfdump exporters, MikroTik, pfSense and most
# switch sFlow agents all take a collector address and port in the same way.
```

## What you get, and what you do not

**You get:** who talked to whom, over what application, through which
interface, and how much — per minute, for fourteen days, and per service per
hour for a year.

**You do not get** per-session forensics. There is no raw flow record in the
database to query.

That is a deliberate trade and it is worth understanding, because it is the
difference between a flow feature that works on a real link and one that
falls over.

### Why records are folded at ingest

A busy edge router exports **tens of thousands of conversations a minute**.
One row per conversation is not "a slow query later" — it is a write path
that fails on the first real link. It is exactly why standalone flow
collectors want their own appliance.

So the collector folds records in memory over the flush interval, keyed by

```
exporter | host-A | host-B | protocol | service | ingress ifIndex
```

and writes one row per key. Two details in that key matter:

- **Direction is normalised.** A conversation is one thing seen from both
  ends, so the endpoints are ordered and A→B folds together with B→A.
- **Ephemeral ports are dropped**, replaced by the service name derived from
  the well-known port of the pair. `10.0.0.5:54321` is not an entity anyone
  wants a row for.

On real traffic that is one to two orders of magnitude fewer rows, and what
survives answers the questions people actually ask.

### The ceiling, and why the totals still add up

A port scan or a volumetric attack creates unique conversations as fast as
the wire allows, and an unbounded aggregator turns that into the collector's
own out-of-memory.

Past `FLOW_MAX_CONVERSATIONS` (default 20 000) the remaining traffic is folded
into a single `(other)` row. The detail is gone; **the totals are still
true**. A graph that quietly under-reports during an attack is worse than one
that says "and this much I could not break down".

---

## Templates, and the first five minutes

NetFlow v9 and IPFIX are self-describing: a data record is unintelligible
until the exporter has sent the template describing it, and exporters re-send
templates only every few minutes.

So a collector that has just started **is deaf until the next template
refresh**. That is inherent to the protocols, not a defect, and it is the
reason a fresh flow deployment looks broken for several minutes.

Watcher counts those records as `pendingTemplates` rather than dropping them
silently, because *"we are waiting for a template"* and *"nothing is
arriving"* are different problems with different fixes.

Templates are cached per **exporter address and observation domain** — two
routers may both use template id 256 with entirely different shapes, and one
shared cache decodes one of them into nonsense.

## Sampling

sFlow always samples, and NetFlow often does. A sample stands for `rate`
packets, so its byte count is multiplied by the rate the agent reports —
reporting the sampled frame alone under-reports a 1-in-1000 sampler by three
orders of magnitude and makes the whole view useless.

The consequence to remember: at a 1-in-1000 rate, a conversation smaller than
about 1000 packets may not be sampled at all. Flow is a good answer to "what
is filling this link" and a poor one to "did this one host talk to that one".

---

## API

| | |
|---|---|
| `GET /api/flow/talkers` | top hosts by volume |
| `GET /api/flow/conversations` | top host pairs |
| `GET /api/flow/services` | volume by application |
| `GET /api/flow/interfaces` | volume by exporter interface |
| `GET /api/flow/series` | a bucketed series for a chart |

All take `hours` (bounded to the fourteen-day retention), `limit` and an
optional `device`. Windows longer than 48 hours read the hourly rollup, which
is kept a year — so "what does backup cost us every night" survives the
conversation retention that first answered it.

## Configuration

| Variable | Default | |
|---|---|---|
| `FLOW_PORT` | *(off)* | UDP port; NetFlow, IPFIX and sFlow all read here |
| `FLOW_FLUSH_MS` | 60000 | how often folded conversations are written |
| `FLOW_MAX_CONVERSATIONS` | 20000 | ceiling before the `(other)` fold |

Schema: `infra/sql/timescale/004_flows.sql`.
