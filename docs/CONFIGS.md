# Configuration backup and drift

Nightly capture of every device's running configuration, kept when it
changed, diffed when you ask, and alerted when a device stops matching what
somebody approved.

This is the whole of SolarWinds NCM and the reason Oxidized and RANCID exist.
The idea is trivial. The execution is not, for one reason.

---

## The reason it is hard

**A device's configuration is not the same twice, even when nothing changed.**

```
! Last configuration change at 09:14:02 UTC Mon Sep 7 2026 by admin
Current configuration : 4213 bytes
ntp clock-period 17179856
```

All three of those differ every night on a device nobody touched. Diff two
captures naively and the tool reports a change every single night — and a
drift alert that fires every night is one nobody reads, which means **the
night it fires for a real reason nobody reads it either.**

So normalisation is not a tidying step here, it is the feature. Each vendor
profile carries the lines that change on their own:

| Profile | Command |
|---|---|
| `cisco-ios` | `show running-config` |
| `cisco-nxos` | `show running-config` |
| `juniper` | `show configuration \| display set \| no-more` |
| `arista` | `show running-config` |
| `aruba` | `show running-config` |
| `mikrotik` | `/export` |
| `fortinet` | `show full-configuration` |
| `generic` | `show running-config` |

Sites add their own with `volatileExtra` (regex sources) on the target — a
broken pattern is ignored rather than taking the capture down.

Line endings, trailing whitespace and runs of blank lines are also not
configuration, and are normalised away.

## Secrets

A running-config carries SNMP communities, RADIUS and TACACS keys,
pre-shared keys and password hashes. **An archive of the whole estate's
configs is a better prize than any single device**, so secret values are
replaced before anything is stored.

That creates a real tension. A flat `<redacted>` protects the value but makes
a rotated community string produce an identical config — the one change an
auditor most wants to see becomes invisible. Hashing the secret would make
rotation visible and hand an attacker an offline guessing target; `public`
does not survive a dictionary for long.

So with `CONFIG_FINGERPRINT_KEY` set, the placeholder carries a **keyed**
fingerprint:

```
snmp-server community <redacted:3f9a1c22> RO
```

Rotation shows as a change. The value never lands in the database, the diff
view, or an alert body. Guessing it from the fingerprint needs the key.

Without a key the placeholder is the flat form, and a rotation is invisible —
stated here rather than discovered.

## Reading a stored config needs operator

Even redacted, a configuration describes ACLs, VPN endpoints, routing and
management addresses — a map of the network for anyone who should not have
one. Viewers see drift status and history; content and diffs are
operator-and-above.

---

## Drift means *approved*, not *yesterday*

Three states, and the third is the one that keeps the feature usable:

| State | Meaning |
|---|---|
| `compliant` | matches the approved baseline |
| `drifted` | differs from the approved baseline — **warning alert** |
| `unapproved` | **nobody has said what this device should be** — not a fault |
| `unknown` | never captured |

A device with no baseline is not drifting. Reporting it as drift makes the
whole view noise on day one, which is how the feature gets turned off in week
two.

And a baseline is an **explicit act** (`POST /api/configs/:deviceId/approve`),
never "the newest version wins". If a device drifted last week and the newest
capture silently became its own baseline, the check would report compliance
forever and mean nothing.

Coming back into line clears the alert, because drift is a comparison against
the baseline in both directions.

## The two dangerous outcomes, handled

- **An empty capture that "succeeded."** It would store an empty version,
  overwrite a good history, and read as a device whose entire configuration
  was deleted. A capture that normalises to under 32 characters is refused
  and raised as a failure.
- **A capture failing after the last success.** The history looks fine and is
  quietly going stale. The fleet view flags it as `capture failing`, and
  every failure raises — the device whose capture has failed for a week is
  the one whose configuration you will most want and least have.

A first capture is deliberately *not* a change. Announcing every device as
changed on the first night is how the feature gets muted before it has been
useful once.

---

## Transport

The system `ssh` binary, not a bundled SSH library. In order of how much it
matters:

- Network equipment is where SSH implementations go to be strange —
  ten-year-old key exchanges, ciphers no modern library ships, hosts that
  need `-oKexAlgorithms=+diffie-hellman-group1-sha1` to talk at all. OpenSSH
  can be told to accept them; a JS library usually cannot.
- Whatever an operator already has in `~/.ssh/config` applies unchanged —
  jump hosts included, which is often the only way a management network is
  reachable.
- It keeps the dependency surface where it is. An SSH library is a large
  amount of security-critical code for one feature.

The cost, stated: this needs `ssh` on the host and **key-based
authentication**. A password would have to be handed to a child process,
which is worse than requiring a key.

`BatchMode=yes` is the load-bearing option — without it a capture against an
unknown host blocks on a prompt until the timeout, every night, silently.

## Turning it on

```bash
CONFIG_BACKUP=1
CONFIG_SSH_USER=watcher
CONFIG_SSH_KEY=/etc/watcher/id_ed25519
CONFIG_FINGERPRINT_KEY=$(openssl rand -hex 32)
```

Then add targets — admin only, because enabling backup points privileged
credentials at network equipment:

```
POST /api/configs/targets
{"deviceId": "…", "vendor": "cisco-ios",
 "volatileExtra": ["^local-counter \\d+$"]}
```

Removing a target keeps the captured history. Turning backup off is not a
request to destroy the record of what the device used to be.

## API

| | |
|---|---|
| `GET /api/configs` | fleet drift overview |
| `GET /api/configs/:deviceId` | version history and recent capture attempts |
| `GET /api/configs/version/:id` | one version's content *(operator)* |
| `GET /api/configs/:deviceId/diff` | against the baseline, or `?from=&to=` *(operator)* |
| `POST /api/configs/:deviceId/approve` | approve a version as baseline *(operator)* |
| `GET/POST/DELETE /api/configs/targets` | which devices are backed up *(admin to write)* |

Configuration alerts ride the ordinary state bus, so correlation, maintenance
windows, on-call and runbooks all apply — a config alert is paged exactly
like a failed ping.

Schema: `infra/sql/postgres/015_configs.sql`.
