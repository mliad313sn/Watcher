-- Watcher configuration plane (PostgreSQL)
-- Tenants, identity/RBAC, device inventory, dashboards, alerting, discovery.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Tenancy ────────────────────────────────────────────────────────────────
CREATE TABLE tenants (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Identity & RBAC ────────────────────────────────────────────────────────
CREATE TYPE user_role AS ENUM ('admin', 'operator', 'viewer');

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    username      text NOT NULL,
    display_name  text NOT NULL DEFAULT '',
    email         text,
    password_hash text NOT NULL,                -- scrypt, see apps/api auth module
    role          user_role NOT NULL DEFAULT 'viewer',
    disabled      boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, username)
);

-- ── Device inventory ───────────────────────────────────────────────────────
CREATE TYPE device_kind AS ENUM
    ('server', 'switch', 'router', 'firewall', 'wireless_ap', 'wireless_controller',
     'pbx', 'printer', 'ups', 'storage', 'virtual', 'other');

CREATE TYPE poll_protocol AS ENUM ('snmp', 'winrm', 'meraki', 'asterisk', 'ping', 'nagios');

CREATE TABLE devices (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name         text NOT NULL,                 -- must match the Nagios host_name when engine-checked
    address      inet,
    kind         device_kind NOT NULL DEFAULT 'other',
    vendor       text,
    model        text,
    os           text,
    location     text,
    -- Topology: parent device for dependency-based alert suppression.
    parent_id    uuid REFERENCES devices(id) ON DELETE SET NULL,
    tags         jsonb NOT NULL DEFAULT '{}'::jsonb,
    monitored    boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);
CREATE INDEX devices_tenant_kind_idx ON devices (tenant_id, kind);
CREATE INDEX devices_parent_idx      ON devices (parent_id);

-- Credential sets referenced by pollers. Secrets are stored encrypted by the
-- API layer (AES-256-GCM with a key from the environment) — never plaintext.
CREATE TABLE credentials (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        text NOT NULL,
    protocol    poll_protocol NOT NULL,
    data_enc    bytea NOT NULL,                 -- encrypted JSON blob
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

-- Which protocols poll which device, with what credentials and interval.
CREATE TABLE poll_assignments (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id     uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    protocol      poll_protocol NOT NULL,
    credential_id uuid REFERENCES credentials(id) ON DELETE SET NULL,
    interval_s    integer NOT NULL DEFAULT 60 CHECK (interval_s >= 10),
    enabled       boolean NOT NULL DEFAULT true,
    config        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- e.g. {"port":161,"ifFilter":"^Gi"}
    UNIQUE (device_id, protocol)
);

-- Discovered L2/L3 adjacency (LLDP/CDP/ARP/route hops) for topology mapping.
CREATE TABLE topology_links (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    a_device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    a_ifname      text,
    b_device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    b_ifname      text,
    layer         smallint NOT NULL DEFAULT 2 CHECK (layer IN (2, 3)),
    source        text NOT NULL DEFAULT 'lldp', -- lldp | cdp | arp | manual | route
    last_seen     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (a_device_id, a_ifname, b_device_id, b_ifname)
);

CREATE TABLE discovery_jobs (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    cidr         cidr NOT NULL,
    protocols    poll_protocol[] NOT NULL DEFAULT '{ping,snmp}',
    credential_ids uuid[] NOT NULL DEFAULT '{}',
    schedule     text,                          -- cron expression, null = manual
    status       text NOT NULL DEFAULT 'idle',  -- idle | running | done | failed
    last_run_at  timestamptz,
    result       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── Dashboards & widgets ───────────────────────────────────────────────────
CREATE TABLE dashboards (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    owner_id    uuid REFERENCES users(id) ON DELETE CASCADE,
    name        text NOT NULL,
    shared      boolean NOT NULL DEFAULT false,
    is_default  boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dashboard_widgets (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_id uuid NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    type         text NOT NULL,                 -- gauge | heatmap | traffic | statusgrid | eventfeed | topn
    title        text NOT NULL DEFAULT '',
    -- 12-column grid placement, drag-and-drop updates these.
    grid_x       smallint NOT NULL DEFAULT 0,
    grid_y       smallint NOT NULL DEFAULT 0,
    grid_w       smallint NOT NULL DEFAULT 4,
    grid_h       smallint NOT NULL DEFAULT 3,
    config       jsonb NOT NULL DEFAULT '{}'::jsonb  -- widget-specific query/config
);
CREATE INDEX dashboard_widgets_dash_idx ON dashboard_widgets (dashboard_id);

-- ── Alerting ───────────────────────────────────────────────────────────────
CREATE TYPE alert_severity AS ENUM ('critical', 'warning', 'info');
CREATE TYPE alert_status   AS ENUM ('open', 'acknowledged', 'suppressed', 'resolved');

CREATE TABLE alerts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    device_id     uuid REFERENCES devices(id) ON DELETE SET NULL,
    device_name   text NOT NULL,
    check_name    text NOT NULL DEFAULT '',     -- empty = host-level alert
    severity      alert_severity NOT NULL,
    status        alert_status NOT NULL DEFAULT 'open',
    message       text NOT NULL,
    occurrences   integer NOT NULL DEFAULT 1,   -- dedup counter
    flapping      boolean NOT NULL DEFAULT false,
    -- When suppressed by dependency logic, which upstream alert caused it.
    suppressed_by uuid REFERENCES alerts(id) ON DELETE SET NULL,
    ack_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
    ack_comment   text,
    opened_at     timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    resolved_at   timestamptz
);
-- One open alert per (device, check): dedup upserts hit this index.
CREATE UNIQUE INDEX alerts_open_dedup_idx
    ON alerts (tenant_id, device_name, check_name)
    WHERE status IN ('open', 'acknowledged', 'suppressed');
CREATE INDEX alerts_tenant_status_idx ON alerts (tenant_id, status, severity);
CREATE INDEX alerts_opened_idx        ON alerts (opened_at DESC);

-- Notification routing rules (email/webhook/etc. fan-out is a worker concern).
CREATE TABLE alert_rules (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        text NOT NULL,
    min_severity alert_severity NOT NULL DEFAULT 'warning',
    match       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"kind":"switch","tags":{"site":"hq"}}
    actions     jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{"type":"email","to":"noc@corp"}]
    enabled     boolean NOT NULL DEFAULT true
);

-- updated_at maintenance
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER devices_touch BEFORE UPDATE ON devices
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER alerts_touch BEFORE UPDATE ON alerts
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
