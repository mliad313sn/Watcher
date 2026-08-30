-- 010: maintenance windows.
-- Planned work should not page anyone and should read as "maintenance", not
-- "outage", on the public status page. A window matches devices by kind
-- and/or name pattern; while active, matching alert notifications are
-- suppressed (alerts still record — history stays honest).
CREATE TABLE IF NOT EXISTS maintenance_windows (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        text NOT NULL,
    starts_at   timestamptz NOT NULL,
    ends_at     timestamptz NOT NULL,
    -- {kind?: device_kind, devicePattern?: regex} — empty matches everything.
    match       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS maintenance_active_idx
    ON maintenance_windows (tenant_id, starts_at, ends_at);
