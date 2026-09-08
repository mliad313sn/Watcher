# Upgrading Watcher

## 1.0.0 → 1.1.0

**Read this first.** Until 1.1.0 there was no migration runner. Schema was
applied only through the container's `/docker-entrypoint-initdb.d` hook,
which runs **once, on an empty data volume**. A fresh install therefore got
everything and an existing install got nothing — the API would start and
every new route would fail on a table that had never been created.

1.1.0 ships `scripts/migrate.mjs` and closes that. Upgrading an existing
install is now:

```bash
git pull && npm install
npm run migrate:status        # what is applied, what is pending
npm run migrate               # apply it
docker compose up -d --build  # or restart the services
```

`npm run migrate` is safe to run repeatedly, on a fresh database or an
existing one, and safe to run when nothing is pending.

### What happens to a database that predates the runner

It has no ledger table but very much has the tables. Re-running `001_init`
on it would fail, and making an operator hand-edit a ledger before they can
upgrade is how upgrades get skipped — so the runner detects this and records
the already-shipped files as applied **without running them**:

```
  postgres: adopted an existing database (12 file(s) recorded as already applied)
  postgres: applied 013_events.sql (28 statements, 240ms)
  postgres: applied 014_proxies.sql (9 statements, 90ms)
  postgres: applied 015_configs.sql (14 statements, 130ms)
  timescale: adopted an existing database (2 file(s) recorded as already applied)
  timescale: applied 003_events.sql (11 statements, 410ms, no transaction — see below)
  timescale: applied 004_flows.sql (10 statements, 380ms, no transaction — see below)
```

### What the runner will refuse to do

- **Re-run anything already applied.** Each file is recorded with the
  checksum of what ran.
- **Proceed if a shipped migration has changed since it was applied.** That
  would mean two estates with the same version number have different
  schemas. Add a new file instead; never edit one that has shipped.

### Two honest caveats

- **Some TimescaleDB statements cannot run in a transaction.** Creating a
  hypertable or a continuous aggregate is refused inside a transaction
  block, so those files run without one and *can* half-apply. The runner
  says so per file. A file that failed part-way is not recorded, so the next
  run retries it — but check the error before re-running, because the retry
  will hit whatever already succeeded.
- **Take a backup first.** This is a schema change against your production
  configuration database. The runner is careful and the migrations are
  additive — no column is dropped and no data is rewritten — but "additive"
  is not "reversible".

### New ports, all off by default

Nothing in 1.1.0 starts listening unless you tell it to. The three receivers
and the config backup are each one environment variable:

| | | |
|---|---|---|
| SNMP traps | `TRAP_PORT=162` | plus `TRAP_COMMUNITIES` or `TRAP_V3_USERS` |
| Syslog | `SYSLOG_PORT=514` | UDP and TCP |
| Flow | `FLOW_PORT=2055` | NetFlow, IPFIX and sFlow on one port |
| Config backup | `CONFIG_BACKUP=1` | needs `ssh` and a key |

162 and 514 are privileged: the shipped systemd unit grants
`CAP_NET_BIND_SERVICE`, and the compose file publishes the ports with
`cap_add: NET_BIND_SERVICE`.

### Nothing in 1.0.0 changed behaviour

Polling, correlation, notification, SSO, the console and the API are as they
were. Event-, flow-, proxy- and config-borne alerts all enter the *existing*
alert pipeline, so correlation, maintenance windows, on-call and runbooks
apply to them without configuration.

---

## Rolling back

The 1.1.0 migrations are additive. Running 1.0.0 code against a 1.1.0 schema
works — the new tables are simply unused — so a rollback is a code rollback:

```bash
git checkout <1.0.0 tag> && npm install && docker compose up -d --build
```

Leave the new tables in place. Dropping them loses the event history and the
configuration versions, and 1.0.0 does not read them.

---

## Checking where you are

```bash
npm run migrate:status
curl -s localhost:8080/healthz
```
