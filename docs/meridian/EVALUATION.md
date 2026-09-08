# Meridian as the PM system for the Watcher 1.1 programme

**An evaluation from use, not from reading.** Meridian was installed, seeded,
run, and used to govern a real delivery programme end to end. Every claim
below is something that happened, with the evidence beside it.

---

## What it was actually used for

The Watcher 1.1 release — five workstreams closing the five gaps that
separated a polling-only monitoring platform from the products it competes
with — was planned, governed, gated and closed out in Meridian.

| | |
|---|---|
| Programme | `WCH` — Watcher Monitoring Platform |
| Projects | 5 (`PRJ-147` traps · `PRJ-150` syslog · `PRJ-153` flow · `PRJ-156` proxies · `PRJ-159` config) |
| Stages | 56 |
| Milestones | 25, including 4 gates per project |
| RAID items | 9 raised, 8 closed with dated evidence |
| Evidence documents | 20, all filed then independently approved |
| Audit rows written | 180 |

Every project was driven from `Initiation` through four gates to
`Transition`. The engineering it governed shipped as **Watcher 1.1.0: 315
tests passing, up from 74.**

The whole programme was run **through the REST API**, headlessly, without
opening the UI once. That is itself a finding — see benefit 7.

---

## What Meridian does that mainstream PM tools do not

### 1. The gate refuses. It does not warn.

The first thing that happened when the trap and syslog work was complete:

```
PATCH /api/projects/PRJ-147/phase {"phase":"Closure"}
→ 409  {"error":"1 evidence item outstanding for Gate 1 — Mandate"}
```

**Meridian would not let me mark finished work as finished.** Jira lets you
drag a card to Done. Monday, Asana, Wrike and Smartsheet let you set a status
field to anything. Microsoft Project has no concept of an evidence gate at
all. In every one of them the gate is a convention that a determined person
routes around in four seconds.

To get past it I had to file the charter, the architecture dossier, the test
evidence and the realisation report, give each a real artefact link, and have
each one approved. That took twenty minutes and it was the right twenty
minutes.

**This is the single reason to choose Meridian.** Everything else is good
engineering; this is a different product category.

### 2. Filing evidence and approving it are different acts, enforced server-side

```
POST /api/documents {"status":"Approved"}
→ 400  "A document is filed, then approved — approving is a separate act,
        so that the trail shows who wrote the evidence and who accepted it"
```

An ownerless document cannot be approved at all, because "the independence
check compares the approver to the owner, and an absent owner matches
nobody" — a segregation-of-duties bypass that most tools would never think to
close. Changing the owner and approving in the same call is also refused:
that is how an owner signs their own work in two steps.

No mainstream PM tool enforces separation of duties on approvals. ServiceNow
SPM and Planview can be configured toward it with workflow effort; here it is
the default and cannot be turned off.

### 3. Evidence must be a *thing*, on a host you named in advance

```
→ 400  "Gate evidence needs its artefact — the link to the piece itself,
        not only a status"
→ 400  "No trusted document hosts are configured — name the group's
        document estate before evidence can be approved"
```

The trusted-host list **ships closed**. An unconfigured control that waves
things through is the failure the product was blocked over, and it shows.
In Jira, "evidence" is a checkbox someone ticks.

### 4. The audit trail cannot be rewritten, and that is enforced by the database

```sql
CREATE RULE audit_no_update AS ON UPDATE TO audit_event DO INSTEAD NOTHING;
CREATE RULE audit_no_delete AS ON DELETE TO audit_event DO INSTEAD NOTHING;
```

Not application code that could be bypassed by the next endpoint someone
adds. The audit insert also shares the mutation's transaction, so **a change
that is not audited does not commit.**

Reading the trail is itself audited — a row appears saying
`Audit trail consulted`. I have not seen another PM tool do that.

*Nuance worth knowing:* `DO INSTEAD NOTHING` silently ignores an UPDATE
rather than raising, so an application bug that tries to rewrite history
fails quietly rather than loudly. The data is safe either way, and anyone
with `DROP RULE` is outside the model.

### 5. Concurrent edits collide instead of silently overwriting

Every mutable row carries `row_version`, every PATCH must state the version
it read, and a second writer gets a `409` — never a silent overwrite. One of
the nine build gates is *"client PATCH calls that do not name a version"*,
so the discipline cannot rot.

Jira, Asana, Monday and Notion are last-write-wins. If two people edit a risk
in the same minute, one of them loses their work and neither is told.

### 6. A project arrives able to be run

Creating each project scaffolded **eight stages, four gates, four evidence
documents and the PM's own resource allocation** automatically. The code says
why: *"A bare project row is not something anyone can run."*

The gates were already there, already blocking, before I had typed anything
into them. In Jira you get an empty board.

### 7. The API is complete enough to run a programme headlessly

Five projects, 56 stages, 25 milestones, 9 RAID items, 20 documents filed and
approved, 15 phase advances — all through REST, scripted, without opening the
UI.

Most PM tools' APIs are a second-class surface where the interesting
operations are missing or behave differently. Meridian's is the same surface
the UI uses, with the same rules applied at the same place. For an automated
or AI-assisted delivery process, this is the difference between usable and
decorative.

### 8. It holds itself to a standard it can prove

`npm test` → **449 tests, all passing** (468 after this evaluation's
contributions). `npm run audit` → **nine static gates, all passing**, including *every screen renders for every role* (84
render checks), *every route matches its published OpenAPI contract*, and
*every mutation has an audit row*.

That is a higher verification bar than most commercial PM products can
demonstrate, and it is checkable in ten minutes because the source is right
there.

### 9. Real earned value, not a progress bar

SPI, CPI, EAC, VAC, TCPI and a forecast finish derived from schedule
performance — genuine EVM, in `shared/engine.js`, behaviour-frozen and
tested. Jira, Linear, Asana and Monday have no EVM at all. Smartsheet and
Wrike approximate it. This is the real thing.

### 10. No vendor, no telemetry, no licence

`npm install && npm run seed && npm run dev` and it is running. Apache-2.0,
patent grant included. A default installation makes no outbound network
request, and NOTICE shows you how to verify that.

---

## Where Meridian falls short of other PM tools

Stated as a buyer would state them.

### It is not where the work happens — and there was no bridge to where it does

> **Since addressed.** This was the report's largest objection and it is the
> one that was built; see *What was contributed back* below. It is left here
> as written because it is why the work was done, and because the objection
> stands for anyone running a version without it.


Meridian says this about itself: *"It is not a task manager, a
time-and-billing system, an ITSM tool, or an agile team board."* Fair. But
the consequence is concrete: **the delivery team's actual work lives in Jira,
Azure DevOps, GitHub or Linear, and Meridian has no native sync to any of
them.**

The interoperability committee chose "four surfaces instead of twenty
connectors" deliberately, and the reasoning is sound. The cost is that
somebody re-enters status, and re-entered status is stale status. This is the
single biggest practical objection, and it is the one most likely to kill an
adoption.

Everything I recorded — 56 stage completions, 25 milestones — I recorded
twice: once in the engineering repository, once here. A Jira/GitHub bridge
that closed a stage when its pull request merged would remove that entirely.

### No chat, no notifications where people already are

No Slack or Teams integration. There is a notification centre and an email
path (SMTP, unconfigured by default), but a PMO tool that cannot post the
weekly digest into the channel the programme actually lives in will be
checked less often than one that can.

### No mobile

No app, and no PWA. A sponsor approving a gate from an airport cannot.

### No in-app report builder

Fourteen stable `reporting.*` SQL views for Power BI, Excel, Tableau and Qlik
— an honest and durable answer, and better than a proprietary export. But if
your PMO does not have a BI capability, there is no drag-and-drop report
designer here and Smartsheet or Monday will feel far more capable.

### No vendor, restated as a cost

Benefit 10 is also a risk. No support contract, no SLA, nobody on call. The
project says so plainly: *"If it breaks on a Sunday, you fix it or you
wait."* That is disqualifying for a regulated programme that requires vendor
indemnity, and no amount of code quality substitutes for it.

### Documentation is mostly French

Code and UI are bilingual; the twenty-five documents in `docs/` that explain
*why* each decision was taken are largely French. For a non-French team, the
richest part of the product is behind a language barrier.

### It has not run a real portfolio for a year

Their own market committee says so. My use was a full working day of
intensive scripted traffic — not twelve months, eight sites and two hundred
users. Everything about the design suggests it would hold. Nothing here
proves it.

### Single-instance by default

PGlite is a single-process engine. Multi-tenant SaaS is explicitly not the
model (instance-per-tenant was decided instead). A real deployment wants
PostgreSQL, a second instance and a tested backup — which the project lists
as three blocking operational findings that are *yours*, not the software's.

### No resource marketplace or skills matching

There is capacity, allocation, rotation, absence and timesheets — more than
Jira and roughly Smartsheet's level. Planview and Clarity go considerably
further for organisations that need skills-based supply and demand matching.

---

## What was contributed back

Three changes, in the order they were recommended in the verdict below.
Each was checked against Meridian's own bar — **468 tests and nine static
gates, all passing** (the suite was 449 before).

Patch: `docs/meridian/meridian-improvements.patch` (both commits).

### Recommendation 1 · The bridge to where the work happens — **built**

The largest gap in this report, and the one most likely to kill an adoption:
everything recorded here was recorded twice, and re-entered status is stale
status.

`v1.js` already named the resolution — *"writes will come with the
integrations that ask for them, never before"* — and the codebase named this
exact backlog item, **INT-10 (Jira, Azure DevOps)**. So this is that
integration, built with the product's grain rather than against it:

```http
POST /api/v1/progress          X-API-Key: <key with write:progress>
{"system":"jira","items":[{"externalId":"10001","state":"closed"}]}
→ {"updated":[{"activity":"PRJ-147-A9","was":50,"now":75,"closed":3,"of":4}],
   "unlinked":["10099"], "unchanged":2, "contended":[]}
```

**No Jira connector. No Azure DevOps connector.** The interoperability
committee's "four surfaces instead of twenty connectors" was right, and
twenty connectors would be twenty authentication debts and twenty reasons
not to upgrade. This is one generic surface any tracker can call.

Three refusals make it safe, and each cost something specific to get right:

- **A key cannot link.** Attaching an item to a stage is a session act under
  the project's `schedule.write`. A stolen key cannot hang invented work on
  any stage in a portfolio. A key posting to `/api/worklinks` gets 401.
- **A key cannot write a percentage.** It reports item states; the stage's
  percent becomes closed-over-linked. A system that could write "78%" makes
  the number unverifiable, whereas "7 of 9" can be re-read, disputed and
  traced to objects an auditor can go and look at. A `pct` in the request
  body is ignored, and a test proves it.
- **Nothing is silent.** Unknown items come back in `unlinked` so an
  integrator sees what still needs mapping. A stage a person edited between
  the read and the write comes back in `contended` and is picked up next
  time — refusing a whole batch over one row would be absurd, and
  overwriting it silently is what `row_version` exists to prevent.

Every movement is audited under the **integration's name**, which is what
migration 025 asked for: *"'system' is not an answer to 'who wrote this
line'."*

19 tests, `docs/33-pont-suivi-de-taches.md`, and the OpenAPI contract
regenerated. One drift was found while building it: the discovery endpoint
listed its endpoints from a hand-kept array, so it announced two doors on the
day there were three. It now derives them from the contract.

### Recommendation 2 · Before-images on every update route — **done**

### The first-run blocker, in detail

README: *"With no `DATABASE_URL` the server runs PGlite from
`server/.data/pgdata`."* It did not. `.env.example` sets `PGLITE_DIR`, but
**nothing loads `.env`** — `dotenv` is not a dependency and is imported
nowhere — so the fallback was an in-memory database.

The failure is silent and total:

```
$ npm run seed
  seeded 12 projects · 10 users · 7 meeting series     ← into memory; dies with the process
$ npm run dev
$ curl localhost:4173/api/auth/accounts
  {"seeded":false,"accounts":[]}                       ← every documented password refused
```

Nothing in the output suggests what happened. This is the first thing every
new user meets.

**Fixed** by making the code do what the README says, with the default
resolved from `db.js` rather than the working directory. An explicit
`dataDir` still wins — including `null`, which is how the audit harnesses ask
for a throwaway instance and must keep doing, or a sweep would overwrite the
real book. Also `mkdir -p`: PGlite creates the last path element only, so a
nested data directory fails with ENOENT before it opens.

*Verified:* a clean clone now reaches a signed-in session with the README's
three commands and no environment variables.

`audit_event` carries `before_json`/`after_json` and `record()` writes them —
but among the call sites they were passed on **deletions** and a few
exceptional acts, not on ordinary updates. Across the 180 audit rows the
campaign wrote, **none carried a before-image, including eight `Item closed`
rows.**

That is the wrong way round for a register: items are closed constantly and
deleted almost never, and *"who closed this risk, and what did it say
before?"* is the first question asked at review.

The first patch fixed the RAID route by hand. This finishes it properly, in
two places rather than forty: `updateVersioned()` now captures the row in the
**same statement that changes it** — a `FROM` subquery evaluated against the
snapshot at statement start, so the image cannot disagree with what was
actually updated and costs no extra round trip — and `audited()` fills it in
when the call site did not name its own.

Every update route records a before-image now, including the ones nobody
thought to annotate. It rides back on a `Symbol`, so the two routes that
return that object straight to the client did not start serialising whole
rows.

*Verified:*

```json
"before_json": {"status":"Open","probability":2,"impact":5,
                "response":"Monitor","title":"…","detail":"…"}
"after_json":  {"status":"Closed"}
```

### Recommendation 3 · The first-run blocker — **fixed**

Described above; it remains the single most important change, because it is
the first thing every new user meets.

---

All three were checked against Meridian's own bar: **468 tests, the nine
static gates and the build all pass.** Two of the project's own tests pin the
exact scope list and migration set and needed updating — which is the point
of having them: an addition has to be deliberate.

---

## Verdict

**Meridian is not a better Jira. It is a governance instrument, and it is a
genuinely good one.**

If what you need is *"prove to an auditor in March why this decision was
taken, who approved the evidence, and that nobody rewrote the record"*, it
does things no mainstream PM tool does — and it does them by refusing, at the
moment of the act, rather than by reporting afterwards that somebody should
not have.

If what you need is *"where does my team put their tickets"*, it is the wrong
tool and says so itself.

**For this programme it was the right choice**, and the gate that refused to
close PRJ-147 without evidence is the reason. It forced the charter, the
architecture note, the test evidence and the realisation report to exist for
all five workstreams — documents that a self-directed engineering effort
would otherwise have skipped, and that are now the reason the release can be
explained to somebody who was not there.

**What would make it adoptable far more widely**, in the order I would build
them:

1. ~~**A Jira / GitHub / Azure DevOps bridge.**~~ **Built** — one generic
   surface that closes a stage when its work items close. This was the only
   item on this list that changes the product's category, and it is the
   reason the report's largest objection no longer stands as written.
2. ~~**Before-images on every update route**~~ **Done** — captured in the
   statement that performs the update, so it applies to routes nobody
   annotated.
3. **Slack / Teams delivery for the weekly digest and gate approvals.**
4. **English translations of the `docs/` decision record.** The reasoning is
   the best thing about this project and most of it is currently unreadable
   to most of its potential users.
5. **A one-page "what breaks if you skip this" operations guide** for the
   three findings the project correctly leaves to the operator: a tested
   backup, a second instance, a written security policy.

---

*Prepared by the delivery committee for the Watcher 1.1 release, 8 September
2026. The portfolio described is live in the Meridian instance under
programme `WCH`.*
