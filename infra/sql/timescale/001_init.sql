-- Watcher metrics store (TimescaleDB)
-- Designed for massive ingest volume and multi-year history:
--   raw hypertable (short retention, compressed)
--     → 5-minute continuous aggregate (medium retention)
--       → 1-hour continuous aggregate (long retention)
--         → 1-day continuous aggregate (kept for years)

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ── Raw samples ────────────────────────────────────────────────────────────
-- Narrow schema: one row per (device, metric, instance) sample. `instance`
-- disambiguates multi-valued metrics (interface name, CPU core, disk mount).
CREATE TABLE metrics (
    time        timestamptz NOT NULL,
    device_id   uuid        NOT NULL,
    metric      text        NOT NULL,   -- e.g. 'if.in.bps', 'cpu.util', 'mem.used.pct'
    instance    text        NOT NULL DEFAULT '',
    value       double precision NOT NULL,
    tags        jsonb
);

SELECT create_hypertable('metrics', by_range('time', INTERVAL '1 day'));
-- Space partitioning spreads concurrent device writes across chunks.
SELECT add_dimension('metrics', by_hash('device_id', 8));

CREATE INDEX metrics_device_metric_time_idx
    ON metrics (device_id, metric, instance, time DESC);

-- Compress raw chunks older than 7 days; segment by series identity so
-- decompression for a single chart touches minimal data.
ALTER TABLE metrics SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'device_id, metric, instance',
    timescaledb.compress_orderby   = 'time DESC'
);
SELECT add_compression_policy('metrics', INTERVAL '7 days');

-- Raw data kept 30 days; history lives in the aggregates below.
SELECT add_retention_policy('metrics', INTERVAL '30 days');

-- ── 5-minute rollup (kept 6 months) ────────────────────────────────────────
CREATE MATERIALIZED VIEW metrics_5m
WITH (timescaledb.continuous) AS
SELECT time_bucket('5 minutes', time) AS bucket,
       device_id, metric, instance,
       avg(value)  AS avg_value,
       max(value)  AS max_value,
       min(value)  AS min_value,
       count(*)    AS samples
FROM metrics
GROUP BY bucket, device_id, metric, instance
WITH NO DATA;

SELECT add_continuous_aggregate_policy('metrics_5m',
    start_offset => INTERVAL '1 hour',
    end_offset   => INTERVAL '5 minutes',
    schedule_interval => INTERVAL '5 minutes');
SELECT add_retention_policy('metrics_5m', INTERVAL '180 days');

-- ── 1-hour rollup (kept 2 years) ───────────────────────────────────────────
CREATE MATERIALIZED VIEW metrics_1h
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', time) AS bucket,
       device_id, metric, instance,
       avg(value)  AS avg_value,
       max(value)  AS max_value,
       min(value)  AS min_value,
       count(*)    AS samples
FROM metrics
GROUP BY bucket, device_id, metric, instance
WITH NO DATA;

SELECT add_continuous_aggregate_policy('metrics_1h',
    start_offset => INTERVAL '3 hours',
    end_offset   => INTERVAL '1 hour',
    schedule_interval => INTERVAL '30 minutes');
SELECT add_retention_policy('metrics_1h', INTERVAL '2 years');

-- ── 1-day rollup (kept 7 years) ────────────────────────────────────────────
CREATE MATERIALIZED VIEW metrics_1d
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 day', time) AS bucket,
       device_id, metric, instance,
       avg(value)  AS avg_value,
       max(value)  AS max_value,
       min(value)  AS min_value,
       count(*)    AS samples
FROM metrics
GROUP BY bucket, device_id, metric, instance
WITH NO DATA;

SELECT add_continuous_aggregate_policy('metrics_1d',
    start_offset => INTERVAL '2 days',
    end_offset   => INTERVAL '1 day',
    schedule_interval => INTERVAL '6 hours');
SELECT add_retention_policy('metrics_1d', INTERVAL '7 years');

-- ── State-change history ───────────────────────────────────────────────────
-- Durable log of Nagios host/service transitions for availability reports
-- (SLA %, outage timelines). Written by the API's nagios streamer.
CREATE TABLE state_changes (
    time        timestamptz NOT NULL,
    device_name text NOT NULL,
    check_name  text NOT NULL DEFAULT '',
    hard        boolean NOT NULL DEFAULT true,
    from_state  smallint NOT NULL,
    to_state    smallint NOT NULL,
    output      text
);
SELECT create_hypertable('state_changes', by_range('time', INTERVAL '7 days'));
CREATE INDEX state_changes_dev_idx ON state_changes (device_name, check_name, time DESC);
SELECT add_retention_policy('state_changes', INTERVAL '3 years');
