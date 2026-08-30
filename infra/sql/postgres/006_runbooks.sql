-- Runbooks / alert enrichment — attach remediation to alerts so a responder
-- opens a page and immediately knows what to do, not just that something broke.

CREATE TABLE IF NOT EXISTS runbooks (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        text NOT NULL,
    -- Match criteria (all present ones must hold):
    --   {"kind":"server","tags":{"site":"hq"},"checkPattern":"CPU|Load",
    --    "devicePattern":"^db-","minSeverity":"warning"}
    match       jsonb NOT NULL DEFAULT '{}'::jsonb,
    steps       text NOT NULL DEFAULT '',           -- remediation, markdown-ish
    links       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{"label":"Grafana","url":"..."}]
    priority    integer NOT NULL DEFAULT 0,          -- higher wins on ties
    enabled     boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS runbooks_tenant_idx ON runbooks (tenant_id) WHERE enabled;
