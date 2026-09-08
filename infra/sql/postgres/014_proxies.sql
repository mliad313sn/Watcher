-- Distributed polling: remote site proxies.
--
-- The problem this solves is not scale, it is reachability. A site behind
-- NAT, or behind a firewall whose owner will not open inbound rules, cannot
-- be polled from a central server at all — and that describes most of the
-- sites in most real estates. A proxy runs *at* the site, polls locally, and
-- pushes over ONE outbound HTTPS connection. That is the Zabbix proxy model,
-- and it is what a multi-site deployment needs before it can exist.
--
-- Two things here are security decisions rather than schema:
--
--  · Enrolment is a one-time secret, burned on first use. A proxy that can
--    enrol repeatedly with a durable secret is a credential an attacker can
--    replay to impersonate a whole site — and the site's monitoring data is
--    the thing that decides whether anyone is paged. (RSK-49.)
--  · A proxy credential is stored only as a SHA-256, like an API token, and
--    is scoped to its own proxy. It cannot read another site's assignments
--    and cannot report on another site's devices.
--
-- And one correctness decision that matters more than either: a proxy that
-- goes silent takes a whole site's monitoring with it, and the site then
-- looks *healthy* — no alerts, because nothing is checking. Silence is
-- therefore itself an alertable condition, and `stale_after_seconds` is the
-- deadline. A distributed monitoring system that does not do this is worse
-- than no monitoring, because it is trusted.

BEGIN;

CREATE TYPE proxy_status AS ENUM ('pending', 'active', 'disabled');

CREATE TABLE proxies (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name          text NOT NULL,
    site          text NOT NULL DEFAULT '',
    description   text NOT NULL DEFAULT '',
    status        proxy_status NOT NULL DEFAULT 'pending',

    -- One-time enrolment. Hash only, with a deadline; cleared the moment it
    -- is redeemed so a leaked value is useless the second time.
    enrol_hash    text UNIQUE,
    enrol_expires timestamptz,

    -- The durable credential, issued at enrolment. SHA-256, shown once.
    token_hash    text UNIQUE,
    enrolled_at   timestamptz,
    enrolled_from inet,

    -- Liveness. `last_seen_at` is stamped by every report and heartbeat.
    last_seen_at  timestamptz,
    agent_version text NOT NULL DEFAULT '',
    -- How long this proxy may be silent before the platform raises. Sites
    -- differ: a satellite link is not a campus, so this is per proxy.
    stale_after_seconds integer NOT NULL DEFAULT 300,
    -- Reported by the proxy on each heartbeat, so a backlog is visible
    -- centrally before it becomes data loss.
    queue_depth   integer NOT NULL DEFAULT 0,

    created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name),
    CONSTRAINT proxies_stale_sane CHECK (stale_after_seconds BETWEEN 60 AND 86400)
);
CREATE INDEX proxies_tenant_idx ON proxies (tenant_id, status);
CREATE INDEX proxies_seen_idx   ON proxies (last_seen_at);

-- Which proxy is responsible for a device. NULL keeps the device on the
-- central poller, which is the existing behaviour and stays the default.
ALTER TABLE devices ADD COLUMN proxy_id uuid REFERENCES proxies(id) ON DELETE SET NULL;
CREATE INDEX devices_proxy_idx ON devices (proxy_id) WHERE proxy_id IS NOT NULL;

COMMIT;
