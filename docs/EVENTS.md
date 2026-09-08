# The event plane — SNMP traps and syslog

Polling asks *"what is true now?"* on a schedule. Between two polls a port
can go down and come back, a redundant PSU can fail over, a BGP session can
reset, a config can be changed — and a poller sees none of it, because by the
time it looks the device is telling the truth again.

That gap is why every serious NMS receives traps and syslog. Watcher's event
plane closes it.

---

## The one thing worth understanding

**Events do not get an alert path of their own.** A rule turns an event into
a state change on `watcher:events:state` — the same channel the Nagios
streamer writes — and from that point on it is the code that was already
there: dedup, dependency suppression, maintenance windows, on-call rotation,
runbook attachment, acknowledgement-SLA escalation, the status page.

An event-born alert and a Nagios-born alert are indistinguishable downstream,
by design. There is one alert model in this product and this is how it stays
that way.

```
 device                receiver           pipeline                    the stack
   │  trap/syslog         │                  │                            │
   ├─────────────────────►│  parse           │                            │
                          ├─────────────────►│  identify sender           │
                          │                  │  rate-limit per source     │
                          │                  │  store (TimescaleDB)       │
                          │                  │  evaluate rules            │
                          │                  ├──── state event ──────────►│
                          │                  │                     dedup, deps,
                          │                  │                     downtime, ack,
                          │                  │                     on-call, pages
```

## The asymmetry that shapes the design

A poll has an OK to come back to. **An event does not.** A trap saying the PSU
failed is never followed by a trap saying it did not.

So a rule that raises must also say how what it raised ends. There are exactly
two honest ways, and a rule uses one of them:

- **A paired clearing rule** — `linkUp` clears what `linkDown` opened. Both
  rules must render the *same* check name, because the check name is the
  alert's dedup key. The shipped pair uses `link {1}` on both sides.
- **`auto_clear_seconds`** — the alert closes itself after that much silence
  from the device. The clock is refreshed every time the event recurs, so a
  condition that is still happening keeps its alert open.

A rule with neither is a pager that never stops, which is how people learn to
ignore a monitoring system. Watcher lets you write one — `auto_clear_seconds`
of `NULL` means "a human closes it" — but it is a decision you make, not a
default made for you.

---

## Turning it on

Both receivers are **off** until you give them a port. A monitoring product
that silently opens 162/udp and 514/udp on every install is a product that
gets uninstalled by a security team.

```bash
# apps/poller
TRAP_PORT=162
TRAP_COMMUNITIES=your-trap-community
SYSLOG_PORT=514
```

162 and 514 are privileged. The shipped systemd unit grants
`CAP_NET_BIND_SERVICE` rather than running the poller as root; if you deploy
another way, either do the same or use high ports and redirect:

```bash
nft add rule inet nat prerouting udp dport 162 redirect to :1162
nft add rule inet nat prerouting udp dport 514 redirect to :1514
```

### SNMPv3 traps

```bash
TRAP_V3_USERS=watcher/authPriv/sha/AuthPassphrase/aes/PrivPassphrase
```

One user per comma-separated entry, as
`name/level/authProtocol/authKey/privProtocol/privKey`. Levels are
`noAuthNoPriv`, `authNoPriv`, `authPriv`. Informs are acknowledged
automatically — a sender that gets no acknowledgement retransmits until it
gives up.

**Authorisation is always on.** A receiver with no community and no v3 user
configured rejects every trap and says so at startup. That is deliberate: a
trap receiver that accepts anything is an open alert-injection port.

---

## Who is allowed to be believed

Syslog over UDP is unauthenticated and trivially spoofable, and an SNMPv1/v2c
community crosses the wire in clear. Anything that can reach the port can
claim to be any device.

So the pipeline identifies the sender before it does anything else:

1. The source address is matched against **device management addresses** in
   inventory.
2. Then against the **`event_sources` allow-list**, which wins — it exists to
   describe the cases inventory gets wrong: a switch that sources syslog from
   a loopback rather than its management address, a relay, an appliance you
   deliberately do not inventory.

An event from an address in neither is **stored and shown, but can never
raise an alert.** It is visible in the console marked `(unknown)`, which is
what you want when you are adding a device — and it cannot page anyone, which
is what you want when someone is spoofing your syslog port.

```
POST /api/events/sources
{"address": "10.0.0.9", "deviceId": "…"}          # attribute to a device
{"address": "10.0.0.9", "label": "log-relay"}     # a sender that is not one
```

## Volume

The event table is the one in the product most likely to be the reason a disk
fills. Syslog volume is not comparable to metric volume, and unlike a metric
an event is text and does not aggregate into a number.

Three limits ship *with* the feature rather than being left to you:

| Limit | Default | Where |
|---|---|---|
| Per-source admission | 200 events/minute | `EVENT_RATE_LIMIT` |
| Compression | after 2 days | `infra/sql/timescale/003_events.sql` |
| Retention | 30 days | same |

Over the ceiling a source is throttled for the rest of the window, and **one**
notice is recorded saying so — a throttle that is itself silent is
indistinguishable from a device that stopped talking.

The hourly per-sender rollup (`events_rate_1h`) is kept for two years and
outlives the raw text on purpose: a year from now the useful question is not
what the message said, it is which device sent four million of them. The
console's "loudest senders" panel reads it.

---

## Rules

An ordered decision list. **First match wins** — rules are a decision list,
not a scoring function, because an operator asking "why did this page me"
deserves one rule to read, not seven that combined into a number.

| Selector | Applies to | Meaning |
|---|---|---|
| `source` | both | `trap`, `syslog`, or unset for both |
| `matchOid` | traps | OID prefix, matched **on label boundaries** |
| `matchPattern` | both | case-insensitive regex over the message |
| `matchApp` | syslog | APP-NAME (5424) or tag (3164) |
| `matchFacility` | syslog | 0–23 |
| `maxSeverity` | syslog | severity ≤ this — `3` means "err and worse" |

Every selector that is set must match. `matchOid` matching on label
boundaries is not a detail: a bare `startsWith` makes the selector
`1.3.6.1.4.1.9` (Cisco) also select `1.3.6.1.4.1.99`, which belongs to
someone else entirely — and pages the wrong team.

### Actions

- **`alert`** — raise at `severity`, dedup on `checkName`.
- **`clear`** — resolve the alert whose check name this rule renders.
- **`drop`** — stop; not even stored.
- **`log`** — store and show, never page. This is also the default for an
  event no rule claims: an unrecognised message is a message we do not
  understand, and paging on those trains people to silence the system.

### Check names decide everything

`checkName` is the alert's dedup key, so it decides whether a thousand traps
are one alert or a thousand.

```
"trap {oid}"     → a flapping port and a failed PSU become the same alert row
"link {1}"       → each interface keeps its own
```

Placeholders: `{oid}` `{app}` `{host}` `{facility}` `{severity}`, and `{1}`…`{9}`
for capture groups from `matchPattern`.

Two mistakes are refused at the moment you write them rather than discovered
at 3am:

- a `checkName` using `{1}` with no `matchPattern` to fill it — it renders
  empty for every event and silently folds a whole switch onto one row;
- a `clear` rule with an empty `checkName` — it would clear the *default*
  per-event name, which never equals the one the raising rule produced, so
  the alert stays open forever.

### What ships

Four trap rules and two syslog rules. Deliberately few: `linkDown`/`linkUp`
as a matched pair, cold start, SNMP authentication failure, and syslog at
`crit`-and-worse and `err`. Everything vendor-specific belongs to whoever
owns that vendor's MIB.

---

## Try a rule before you trust it

```
POST /api/events/test
{"source":"syslog","appName":"bgpd","severity":3,"message":"neighbor 10.0.0.1 Down"}
→ {"decision":{"action":"alert","severity":"critical","checkName":"syslog bgpd",
               "ruleName":"Syslog error","autoClearSeconds":3600}}
```

Runs the live rule set, stores nothing, pages nobody. The console has it
behind **Events → Test an event**. This is the single most useful thing when
writing rules, and it is why the rule engine is a pure function in
`@watcher/shared` rather than logic buried inside the receiver — the API, the
receiver and the tests all evaluate rules with the same code.

---

## API

| | |
|---|---|
| `GET /api/events` | search: `source`, `device`, `action`, `oid`, `maxSeverity`, `since`, `q`, `limit` |
| `GET /api/events/summary?hours=24` | volume by sender |
| `GET/POST/PATCH/DELETE /api/events/rules` | the decision list (writes need operator) |
| `GET/POST/DELETE /api/events/sources` | the sender allow-list |
| `POST /api/events/test` | dry run |

Rule and source writes publish `watcher:events:rules-changed`, so receivers
pick a change up on the next event rather than after a cache expiry. A rule
you edited that does not take effect for thirty seconds is a rule you will
edit twice.

---

## Schema

- `infra/sql/postgres/013_events.sql` — `event_rules`, `event_sources`,
  `alert_auto_clear`, and the starting rule set.
- `infra/sql/timescale/003_events.sql` — the `events` hypertable, its
  compression and retention policies, and the `events_rate_1h` rollup.
