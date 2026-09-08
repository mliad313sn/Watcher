-- Event plane: SNMP traps and syslog.
--
-- Two tables. `event_rules` is the decision list that turns an event into
-- an alert (or into nothing); `event_sources` is the allow-list that decides
-- whose events we are willing to believe at all.
--
-- The allow-list is not optional decoration. Syslog over UDP is
-- unauthenticated and trivially spoofable, and an SNMPv1/v2c trap carries a
-- community string that crosses the wire in clear. Anything that can reach
-- the port can claim to be any device. Binding a source address to an
-- inventory device — and refusing, by default, to raise alerts from
-- addresses that are in neither the inventory nor this table — is what
-- stops the event plane from being an alert-injection API.

BEGIN;

CREATE TYPE event_source_kind AS ENUM ('trap', 'syslog');
CREATE TYPE event_rule_action AS ENUM ('alert', 'clear', 'drop', 'log');

-- ── who may speak ────────────────────────────────────────────────────
-- A row here says "this address is this device". Addresses that resolve to
-- an inventory device by their management address need no row; this table
-- is for the rest — a loopback that differs from the management address, a
-- device behind a relay, a source we have decided to trust unnamed.
CREATE TABLE event_sources (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    address     inet NOT NULL,
    device_id   uuid REFERENCES devices(id) ON DELETE CASCADE,
    -- A name for events from an address that is deliberately not a device
    -- (a relay, an appliance we do not inventory). Alerts still carry it.
    label       text NOT NULL DEFAULT '',
    -- false parks a noisy source without losing the mapping.
    enabled     boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, address)
);
CREATE INDEX event_sources_device_idx ON event_sources (device_id);

-- ── what an event means ──────────────────────────────────────────────
-- Ordered by `priority` ascending; first match wins. Evaluated by
-- evaluateEvent() in @watcher/shared so the receiver, the API and the tests
-- all agree on what a rule set says.
CREATE TABLE event_rules (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name          text NOT NULL,
    -- 'trap', 'syslog', or NULL for both.
    source        event_source_kind,
    enabled       boolean NOT NULL DEFAULT true,
    priority      integer NOT NULL DEFAULT 100,

    -- selectors; every one that is set must match (AND), unset means "any"
    match_oid     text NOT NULL DEFAULT '',   -- trap OID, matched on label boundaries
    match_pattern text NOT NULL DEFAULT '',   -- case-insensitive regex over the message
    match_app     text NOT NULL DEFAULT '',   -- syslog APP-NAME / tag
    match_facility  integer,                  -- syslog facility 0..23
    max_severity    integer,                  -- syslog severity <= this (0 = emerg)

    action        event_rule_action NOT NULL DEFAULT 'alert',
    severity      alert_severity NOT NULL DEFAULT 'warning',
    -- Template; {oid} {app} {host} {facility} {severity} {1}..{9} expand.
    -- This is the alert's check_name, so it is also its dedup key.
    check_name    text NOT NULL DEFAULT '',
    -- An event has no OK to come back to. A raising rule must therefore say
    -- how what it raises ends: a paired 'clear' rule on the same check_name,
    -- or this. NULL means "a human closes it", which is a deliberate choice
    -- and not a default we make for anyone.
    auto_clear_seconds integer,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT event_rules_facility_range CHECK (match_facility IS NULL OR match_facility BETWEEN 0 AND 23),
    CONSTRAINT event_rules_severity_range CHECK (max_severity   IS NULL OR max_severity   BETWEEN 0 AND 7),
    CONSTRAINT event_rules_autoclear_sane CHECK (auto_clear_seconds IS NULL OR auto_clear_seconds BETWEEN 30 AND 604800)
);
CREATE INDEX event_rules_lookup_idx ON event_rules (tenant_id, enabled, priority);

-- ── alerts that must close themselves ────────────────────────────────
-- An alert raised by a rule with auto_clear_seconds gets a row here; the
-- sweeper resolves it when the deadline passes and nothing has refreshed
-- it. Kept beside `alerts` rather than inside it so the alerts table stays
-- the one shape every other module already reads.
CREATE TABLE alert_auto_clear (
    alert_id    uuid PRIMARY KEY REFERENCES alerts(id) ON DELETE CASCADE,
    clear_at    timestamptz NOT NULL,
    rule_id     uuid REFERENCES event_rules(id) ON DELETE SET NULL
);
CREATE INDEX alert_auto_clear_due_idx ON alert_auto_clear (clear_at);

-- ── a starting rule set ──────────────────────────────────────────────
-- Deliberately small. These four are the events that every network on
-- earth emits and that every operator wants on day one; everything vendor
-- specific belongs to the person who owns the vendor's MIB, not to us.
INSERT INTO event_rules (tenant_id, name, source, priority, match_oid, action, severity, check_name, auto_clear_seconds)
SELECT t.id, v.name, v.source::event_source_kind, v.priority, v.oid,
       v.action::event_rule_action, v.severity::alert_severity, v.check_name, v.auto_clear
  FROM tenants t
 CROSS JOIN (VALUES
    -- linkDown / linkUp are a matched pair: the clear resolves exactly the
    -- alert the raise opened, because both render the same check name.
    ('Link down',            'trap',  10, '1.3.6.1.6.3.1.1.5.3', 'alert', 'critical', 'link {1}',  3600),
    ('Link up (clears)',     'trap',  11, '1.3.6.1.6.3.1.1.5.4', 'clear', 'info',     'link {1}',  NULL),
    ('Device cold start',    'trap',  20, '1.3.6.1.6.3.1.1.5.1', 'alert', 'warning',  'restarted', 900),
    ('Authentication failure','trap', 30, '1.3.6.1.6.3.1.1.5.5', 'alert', 'warning',  'SNMP auth failure', 3600)
 ) AS v(name, source, priority, oid, action, severity, check_name, auto_clear);

-- Syslog: two rules, both about the two things a device says when it is in
-- real trouble. Everything else is stored and searchable but does not page.
INSERT INTO event_rules (tenant_id, name, source, priority, max_severity, action, severity, check_name, auto_clear_seconds)
SELECT t.id, 'Syslog emergency/alert/critical', 'syslog', 40, 2,
       'alert', 'critical', 'syslog {app}', 3600
  FROM tenants t;
INSERT INTO event_rules (tenant_id, name, source, priority, max_severity, action, severity, check_name, auto_clear_seconds)
SELECT t.id, 'Syslog error', 'syslog', 50, 3,
       'alert', 'warning', 'syslog {app}', 3600
  FROM tenants t;

COMMIT;
