-- On-call schedules & rotations — turns escalation from "page a static webhook"
-- into "page whoever is on call right now," the property that makes an alerting
-- tool the team's actual safety net.

CREATE TABLE IF NOT EXISTS oncall_schedules (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name                text NOT NULL,
    timezone            text NOT NULL DEFAULT 'UTC',
    -- Rotation length in seconds (default weekly). handoff_at anchors position 0.
    rotation_interval_s integer NOT NULL DEFAULT 604800 CHECK (rotation_interval_s >= 3600),
    handoff_at          timestamptz NOT NULL DEFAULT now(),
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

-- Ordered rotation members. `contact` is how the notifier reaches them:
--   {"type":"webhook","url":"..."} | {"type":"slack","url":"..."}
--   {"type":"email","gatewayUrl":"...","to":"..."} | {"type":"log"}
CREATE TABLE IF NOT EXISTS oncall_participants (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id uuid NOT NULL REFERENCES oncall_schedules(id) ON DELETE CASCADE,
    position    integer NOT NULL,
    name        text NOT NULL,
    user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
    contact     jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (schedule_id, position)
);
CREATE INDEX IF NOT EXISTS oncall_participants_sched_idx
    ON oncall_participants (schedule_id, position);

-- Temporary cover: an override wins over the rotation for its window.
CREATE TABLE IF NOT EXISTS oncall_overrides (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id uuid NOT NULL REFERENCES oncall_schedules(id) ON DELETE CASCADE,
    name        text NOT NULL,
    contact     jsonb NOT NULL DEFAULT '{}'::jsonb,
    starts_at   timestamptz NOT NULL,
    ends_at     timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS oncall_overrides_sched_idx
    ON oncall_overrides (schedule_id, starts_at, ends_at);
