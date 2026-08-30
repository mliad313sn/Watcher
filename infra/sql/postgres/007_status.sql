-- Public status page — stakeholder communication without extra tooling.
-- Components group the fleet into audience-facing services (e.g. "Core
-- Network", "Compute") whose status is rolled up from live state. The public
-- endpoint exposes only component names + status, never internal hostnames.

CREATE TABLE IF NOT EXISTS status_components (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        text NOT NULL,
    position    integer NOT NULL DEFAULT 0,
    match       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"kind":"switch","tags":{...}}
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS status_components_tenant_idx ON status_components (tenant_id, position);
