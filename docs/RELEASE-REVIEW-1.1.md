# Release readiness review — 1.1.0

An adversarial pass over the five surfaces added in this release, before
calling it a release rather than a candidate. Five findings, all fixed, all
with regression tests.

The two that mattered are both **silent failures**: neither would have been
noticed until it had already cost something.

---

## R1 · The SNMP trap community was stored, and any viewer could read it
**Severity: high (credential disclosure)**

`GET /api/events` is a `viewer` route and returns the event's `detail`
column. The trap receiver was writing the community string into it:

```js
detail: { …, community: data.pdu.community }        // before
```

A v1/v2c community is the shared secret that authenticates the trap. Storing
it published, to the least privileged role in the product, the credential for
every device in the estate that sends traps — and from there, to the devices
themselves.

**Fixed.** The community is never recorded. What is recorded is *that* the
trap authenticated (`auth: "community" | "usm" | "none"`) and, for SNMPv3,
the **user name** — which is not a secret, because the auth and privacy keys
are, and those never reach this code. "Which identity sent this" stays
answerable.

The construction of the event moved out of the receiver into an exported
`trapToEvent()`, so the decision about what is recorded is testable without
a socket.

---

## R2 · Arming an auto-clear deadline stalled the receiver
**Severity: high (availability, on the default configuration)**

An event-born alert closes itself after a deadline. The deadline attaches to
an alert row the correlation engine creates *from the message the pipeline
has just published* — so at the moment of publishing, the row does not exist
yet. The candidate handled that with a retry loop:

```js
for (let attempt = 0; attempt < 5; attempt++) {   // before
  …
  await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
}
```

That loop was **awaited inside the receiver's drain loop**, so every raising
event could stall the receiver for up to 1.5 seconds. Every rule shipped in
`013_events.sql` sets an auto-clear, so this was the default path — and it
stalled precisely during a flood, which is the moment a receiver must not.

**Fixed.** Deadlines are queued in memory keyed by the *alert's* identity and
attached by a flusher on a 2-second timer, in one batched statement. Three
consequences fall out for free:

- A thousand traps from one flapping port arm **one** deadline and refresh
  it — which is the semantics wanted anyway, since the clock measures silence
  from the device rather than age of the alert.
- The map is bounded at 20 000, so a flood cannot grow it without limit.
- A deadline whose alert never appears is retried for five passes then let
  go: the engine deduped or suppressed it, and there is nothing to close.

A failed flush puts its entries back. Shutdown drains before exit.

*Measured:* 50 raising events now complete in under 500ms against a database
double; before the fix the same path could take 75 seconds.

---

## R3 · Event search had no floor in time
**Severity: medium (performance)**

`GET /api/events` applied a time bound only when the caller supplied `since`.
A text search matching nothing therefore walked every chunk of the 30-day
retention before returning an empty page — and searching for a string that is
*not* there is the first thing anyone does after an incident.

**Fixed.** Searches default to the last 24 hours, and the window used is
returned in the response so it is never a silent truncation.

---

## R4 · Malformed uuid path parameters answered 500
**Severity: medium (correctness)**

Path parameters went to Postgres unvalidated. A malformed uuid became a
`22P02` and surfaced as a 500 for what is plainly a bad request — noise in
the logs, and an error that says nothing useful to a caller.

**Fixed.** Schema validation on the uuid parameters of the events, configs
and proxy routes; the flow routes ignore a `device` filter that is not a
uuid rather than passing it through.

---

## R5 · The enrolment endpoint was unauthenticated and unlimited
**Severity: medium (availability)**

`POST /api/proxy/enrol` is necessarily unauthenticated — it is where a proxy
that has no credential gets one. The secret is 32 bytes of CSPRNG and is not
guessable, but every attempt cost a database round trip, and nothing bounded
the rate.

**Fixed.** 20 attempts per source address per 15 minutes, answered `429` with
`Retry-After`. Deliberately generous: a whole site can arrive behind one
corporate gateway, and locking that out is a denial of service an attacker
would be glad to trigger. In memory on purpose — a restart forgiving the
counters is acceptable; a table of attacker-supplied addresses is not.

---

## Verification

| | |
|---|---|
| Workspace tests | **291 passing** (was 280) |
| New regressions | 11, in `apps/poller/test/release-review.test.js` |
| Web build | clean |

Each finding has a test that fails against the pre-fix code. The two silent
ones are asserted by their observable consequence rather than their
implementation: the community must not appear *anywhere* in the serialised
event, and 50 raising events must complete inside 500ms.
