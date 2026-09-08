-- Device configuration backup, versioning and drift.
--
-- Content-addressed: a version row exists only when the NORMALISED
-- configuration actually changed. That is not a storage optimisation, it is
-- what makes the history readable — a table with one row per device per
-- night is a table nobody opens, and the whole point is to be able to answer
-- "what changed on this switch, and when".
--
-- What is stored has already been through redaction (see
-- packages/shared/src/config-drift.js). A running-config carries SNMP
-- communities, RADIUS and TACACS keys, pre-shared keys and password hashes,
-- and an archive of the whole estate's configs is a better prize than any
-- single device (RSK-50). Secret values never reach this table; where a
-- fingerprint key is configured they are represented by a keyed HMAC prefix,
-- so a rotation is still visible as a change without the value being here.

BEGIN;

CREATE TYPE config_capture_status AS ENUM ('ok', 'unchanged', 'failed');

-- One row per distinct configuration a device has had.
CREATE TABLE device_configs (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    device_id    uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    -- sha256 of the normalised text: the version's identity.
    content_hash text NOT NULL,
    content      text NOT NULL,
    vendor       text NOT NULL DEFAULT 'generic',
    -- Bytes as captured, before normalisation — useful when a capture looks
    -- suspiciously short and you need to know whether the device truncated.
    raw_bytes    integer NOT NULL DEFAULT 0,
    captured_at  timestamptz NOT NULL DEFAULT now(),
    -- Counted against the version this one replaced, so the history reads
    -- without re-diffing every pair.
    lines_added   integer NOT NULL DEFAULT 0,
    lines_removed integer NOT NULL DEFAULT 0,
    UNIQUE (device_id, content_hash)
);
CREATE INDEX device_configs_device_time_idx ON device_configs (device_id, captured_at DESC);
CREATE INDEX device_configs_tenant_time_idx ON device_configs (tenant_id, captured_at DESC);

-- The approved configuration a device is expected to match. Deliberately
-- separate from "the newest version": drift means differing from what
-- somebody APPROVED, not from what the device happened to look like
-- yesterday. Without that distinction a device that drifted last week
-- silently becomes its own baseline and the check means nothing.
CREATE TABLE config_baselines (
    device_id    uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    config_id    uuid NOT NULL REFERENCES device_configs(id) ON DELETE CASCADE,
    content_hash text NOT NULL,
    approved_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_at  timestamptz NOT NULL DEFAULT now(),
    note         text NOT NULL DEFAULT ''
);

-- Every attempt, including the ones that failed. A device whose capture has
-- been failing for a week is the one whose configuration you will most want
-- and least have, so the failures are as important as the successes and are
-- not merely a log line.
CREATE TABLE config_captures (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    status      config_capture_status NOT NULL,
    config_id   uuid REFERENCES device_configs(id) ON DELETE SET NULL,
    error       text NOT NULL DEFAULT '',
    duration_ms integer NOT NULL DEFAULT 0,
    at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX config_captures_device_idx ON config_captures (device_id, at DESC);
CREATE INDEX config_captures_failed_idx ON config_captures (tenant_id, at DESC)
    WHERE status = 'failed';

-- Per-device capture settings. A device with no row here is not backed up,
-- which is the default: reaching into every device with privileged
-- credentials is not something a monitoring product should start doing on
-- its own.
CREATE TABLE config_targets (
    device_id      uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    vendor         text NOT NULL DEFAULT 'generic',
    credential_id  uuid REFERENCES credentials(id) ON DELETE SET NULL,
    -- Overrides the vendor profile's command when a device needs coaxing.
    command        text NOT NULL DEFAULT '',
    -- Site-specific volatile line patterns, as regex sources.
    volatile_extra jsonb NOT NULL DEFAULT '[]'::jsonb,
    enabled        boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX config_targets_tenant_idx ON config_targets (tenant_id) WHERE enabled;

COMMIT;
