-- Event store: received SNMP traps and syslog messages.
--
-- This table is the one in the product most likely to be the reason a disk
-- fills. Syslog volume is not comparable to metric volume — a single chatty
-- firewall at debug level out-produces the entire SNMP estate — and unlike a
-- metric, an event is text and does not aggregate into a number. So the
-- limits ship WITH the feature, in this file, rather than being left as an
-- exercise: compression at two days, hard retention at thirty, and a
-- per-source hourly rollup that survives the raw rows so "who filled the
-- disk" is still answerable after the evidence has been dropped.
--
-- RSK-47 on the delivery register ("unbounded syslog retention exhausts the
-- metrics store") is closed by this file and by the receiver's per-source
-- rate limit together; neither alone is enough.

CREATE TABLE events (
    time        timestamptz NOT NULL,
    tenant_id   uuid        NOT NULL,
    source      text        NOT NULL,          -- 'trap' | 'syslog'
    device_id   uuid,                          -- null when the sender is unknown
    device_name text        NOT NULL DEFAULT '',
    source_ip   inet,
    -- trap: the snmpTrapOID varbind. syslog: empty.
    oid         text        NOT NULL DEFAULT '',
    -- syslog: facility/severity as received. trap: null.
    facility    smallint,
    severity    smallint,
    app_name    text        NOT NULL DEFAULT '',
    message     text        NOT NULL DEFAULT '',
    -- trap varbinds, or syslog structured data, as received.
    detail      jsonb,
    -- What the rule engine decided, recorded so an operator asked "why did
    -- this page me" gets an answer from the event itself rather than from a
    -- rule set that has since been edited.
    rule_id     uuid,
    rule_name   text        NOT NULL DEFAULT '',
    action      text        NOT NULL DEFAULT 'log',
    check_name  text        NOT NULL DEFAULT ''
);

SELECT create_hypertable('events', by_range('time', INTERVAL '1 day'));
SELECT add_dimension('events', by_hash('tenant_id', 4));

-- The three searches an operator actually runs: everything from this device,
-- everything matching this rule, everything at this severity.
CREATE INDEX events_device_time_idx ON events (device_id, time DESC);
CREATE INDEX events_tenant_time_idx ON events (tenant_id, time DESC);
CREATE INDEX events_rule_time_idx   ON events (rule_id, time DESC) WHERE rule_id IS NOT NULL;
CREATE INDEX events_sev_time_idx    ON events (tenant_id, severity, time DESC);

ALTER TABLE events SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'tenant_id, device_id, source',
    timescaledb.compress_orderby   = 'time DESC'
);
SELECT add_compression_policy('events', INTERVAL '2 days');

-- Thirty days of raw text. Anything an audit needs to keep beyond that is a
-- job for an archive, not for the live monitoring store.
SELECT add_retention_policy('events', INTERVAL '30 days');

-- ── who is shouting ────────────────────────────────────────────────────────
-- Outlives the raw rows on purpose: a year from now the useful question is
-- not what the message said, it is which device sent four million of them.
CREATE MATERIALIZED VIEW events_rate_1h
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', time) AS bucket,
       tenant_id, source, device_id, device_name,
       count(*)                                   AS events,
       count(*) FILTER (WHERE action = 'alert')   AS alerting,
       count(*) FILTER (WHERE severity <= 3)      AS errors
FROM events
GROUP BY bucket, tenant_id, source, device_id, device_name
WITH NO DATA;

SELECT add_continuous_aggregate_policy('events_rate_1h',
    start_offset => INTERVAL '3 hours',
    end_offset   => INTERVAL '1 hour',
    schedule_interval => INTERVAL '30 minutes');
SELECT add_retention_policy('events_rate_1h', INTERVAL '2 years');
