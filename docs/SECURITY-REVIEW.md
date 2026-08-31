# Security review — release 1.0 surfaces (R1)

Adversarial pass over the surfaces added in the enterprise/ecosystem waves.
Findings fixed in the same change; each carries a regression test.

## Findings & fixes

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | **High** | **SSO local-account takeover.** The JIT upsert on OIDC/LDAP login keyed on `(tenant, username)` and updated `role` + `auth_source` — an IdP-controlled `preferred_username` colliding with a *local* account (e.g. `admin`) would seize its role and provenance. | Federated logins may only create or refresh accounts whose `auth_source` matches their own source; a collision with a local (or other-source) account refuses the login before any write, with a guarded upsert as a race backstop. Verified: attack refused, local admin's role/hash/provenance untouched. |
| 2 | Medium | **Channel secrets echoed by the read API.** `GET /api/alerts/rules` returned Opsgenie/Jira/Telegram/PagerDuty/SMTP credentials verbatim to any operator session. | Secret fields redact to `•••` in all rule reads (presence stays visible). Admin-only `GET /api/config/export` retains full values by design (backup/GitOps). |

## Reviewed and accepted as-is

- **API tokens**: secrets stored as SHA-256 only; lookup by hash (no
  user-controlled comparison → no timing oracle); role-capped; tokens cannot
  mint tokens; expiry enforced in the lookup.
- **Ingest endpoints**: tenant-scoped by the authenticated principal;
  parameterized SQL throughout; external check names namespaced (`am:`,
  `ext:`) so they can't collide with engine-owned checks; body sizes bounded
  by schema (`maxItems`, `maxLength`). Rate limiting = R2 (next item).
- **Config import**: transactional, parameterized, admin-only;
  `devicePattern` regexes compile inside try/catch at match time (a broken
  or hostile pattern matches nothing).
- **OIDC flow**: single-use anti-CSRF state (Redis GETDEL), token returned
  in the URL fragment (never query/logs), userinfo-endpoint validation,
  deny-by-default role mapping.
- **LDAP**: filter metacharacters escaped; the directory itself is the
  password oracle (bind-as-user); local accounts always take precedence.
- **`/api/alerts/test-channel`**: admin-only. An admin can point it at
  internal URLs (SSRF-shaped by design — it exists to test arbitrary
  webhook targets); accepted, documented here.
- **Event bus**: all three Redis subscribers drop malformed JSON instead of
  crashing (hardened in an earlier wave after a live repro).
- **Mobile ack tokens**: single-purpose claims (`purpose:'ack'`, one
  alertId), 24 h expiry, verified server-side on both info and ack.

Regression suite: `SECURITY E2E` (7 assertions) + 74 unit tests.
