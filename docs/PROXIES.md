# Distributed polling — remote site proxies

The problem this solves is not scale, it is **reachability**.

A site behind NAT, or behind a firewall whose owner will not open inbound
rules, cannot be polled from a central server at all — and that describes
most of the sites in most real estates. A proxy runs *at* the site, polls
locally, and pushes over one outbound HTTPS connection.

```
 central API ◄──── HTTPS (outbound only) ────┤ proxy ├──── SNMP/WMI/ICMP ───► devices
```

No inbound rule. No VPN. **No database credential at the site.**

---

## The safety property that matters most

When a proxy stops reporting, its whole site stops being checked — and the
console then shows **no alerts for that site, because nothing is checking
it.** The site looks healthy.

That is the failure mode that makes a distributed monitoring system *worse
than none at all*, because it is trusted.

So proxy silence is itself a **critical alert**, raised against the proxy's
own name through the ordinary pipeline — same console, same on-call rotation,
same escalation — and it says how many devices are affected:

```
Proxy "gru-01" at São Paulo has been silent for 412s (deadline 300s).
14 device(s) are NOT being monitored.
```

The deadline is per proxy (`staleAfterSeconds`, 60–86400). A satellite link
is not a campus, and one global number would either page constantly for the
slow site or stay quiet far too long for the fast one.

A proxy that has **never** reported is not stale — it has been created and
not yet enrolled, which is a different condition with a different fix. Paging
someone on the day they set a proxy up is how they learn to ignore the alert
that matters.

---

## Setting one up

**1. Register it centrally** (admin):

```
POST /api/proxy  {"name": "gru-01", "site": "São Paulo", "staleAfterSeconds": 300}
→ {"enrolmentSecret": "wpe_…", "expiresInMinutes": 60}
```

The enrolment secret is shown **once** and expires in an hour.

**2. Start the poller at the site** with it:

```bash
WATCHER_PROXY_URL=https://watcher.example \
WATCHER_PROXY_ENROL=wpe_… \
WATCHER_PROXY_CREDENTIALS=/etc/watcher/site-credentials.json \
node apps/poller/src/index.js
```

On first start the proxy exchanges the secret for a durable credential and
logs it once. Store it as `WATCHER_PROXY_TOKEN` and drop `WATCHER_PROXY_ENROL`.

**3. Assign devices** to the proxy (`devices.proxy_id`). A device with no
proxy stays on the central poller, which is the default and unchanged
behaviour.

## Why enrolment is one-time

A proxy that can enrol repeatedly with a durable secret is a credential an
attacker can replay to impersonate a whole site — and a site's monitoring
data is what decides whether anyone gets paged. Suppressing it is as good as
cutting the fibre, and quieter.

So the redemption is a single statement that matches the enrolment hash **and
clears it at once**:

```sql
UPDATE proxies SET token_hash = $2, enrol_hash = NULL, …
 WHERE enrol_hash = $1 AND enrol_expires > now()
```

Two proxies racing the same secret produce exactly one winner; the second
finds no row. A check-then-write here would let a replayed secret mint a
second credential for the same site.

A failed enrolment answers one message for *wrong*, *expired* and *already
used*. Which of the three it was is exactly what an attacker would like to
know.

## What a leaked proxy credential does and does not get you

| | |
|---|---|
| Read its own assignments | yes |
| Report on **its own** devices | yes |
| Report on another site's devices | **no** — rejected and logged |
| Read alerts, users, configuration | **no** — a proxy is not a user and never travels through `requireRole` |
| Any device password | **no** — see below |

**Device credentials never leave the centre.** An assignment carries the
*name* of a credential; the secret itself lives in the proxy's own
`WATCHER_PROXY_CREDENTIALS` file at the site. A captured proxy credential
gives an attacker no way into the site's equipment — and it is half the
reason a site will agree to host a proxy at all.

`POST /api/proxy/:id/reissue` mints a new enrolment secret **and revokes the
durable one**. If you are asking, the proxy is being rebuilt or its
credential is suspect; leaving the old one live would defeat the exercise.

---

## Surviving the link

A proxy sits at the far end of exactly the link most likely to fail, so *"the
API is unreachable"* is a normal operating state, not an incident.

- Observations are **buffered**, bounded at `WATCHER_PROXY_BUFFER` (50 000).
- A batch is committed **only when the server confirms it**. A proxy that
  deletes on send loses exactly the observations that were in flight when
  the link failed — the moment they matter most.
- Past the bound the **oldest** are dropped, not the newest. This is the
  opposite of a queue and it is deliberate: after a two-day outage an
  operator needs the site's current state, not a faithful replay of Tuesday.
  Monitoring data is perishable in a way a work queue is not.
- What was dropped is counted and reported, so loss is visible.
- Retries use exponential backoff with **full jitter**. When a central API
  restarts every proxy discovers it in the same second, and a synchronised
  herd is how a recovering API gets knocked back over.
- Queue depth is sent with every report and heartbeat, so a backlog shows
  centrally as `behind` before it becomes loss.

A rejected credential (401) is not retried as though transient — it is
logged as needing re-enrolment, because retrying forever hides the real
problem from whoever reads the log.

---

## Configuration

| Variable | |
|---|---|
| `WATCHER_PROXY_URL` | central API origin — **setting this enables proxy mode** |
| `WATCHER_PROXY_ENROL` | one-time enrolment secret, first start only |
| `WATCHER_PROXY_TOKEN` | durable credential, after enrolment |
| `WATCHER_PROXY_CREDENTIALS` | JSON file of device credentials, keyed by credential name |
| `WATCHER_PROXY_BUFFER` | observations held across an outage (default 50000) |
| `WATCHER_PROXY_FLUSH_MS` | delivery interval when healthy (default 15000) |

## API

| | |
|---|---|
| `GET /api/proxy` | the fleet with health: `healthy`, `behind`, `silent`, `never connected`, `disabled` |
| `POST /api/proxy` | register; returns the one-time enrolment secret |
| `POST /api/proxy/:id/reissue` | new enrolment secret, revokes the current credential |
| `PATCH /api/proxy/:id` | rename, re-site, enable/disable, change the deadline |
| `DELETE /api/proxy/:id` | remove; its devices fall back to the central poller |

Proxy-facing (`X-Proxy-Token`): `POST /enrol`, `GET /assignments`,
`POST /report`, `POST /heartbeat`.

Schema: `infra/sql/postgres/014_proxies.sql`.
