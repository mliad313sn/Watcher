-- Metrics de-duplication (issue: metrics dedup).
-- A poller retry can re-emit the same sample; without a uniqueness guard that
-- double-counts. TimescaleDB requires a unique index to include every
-- partitioning dimension (time + device_id here), which this satisfies.
-- The writer inserts with ON CONFLICT DO NOTHING so retries are idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS metrics_dedup_idx
    ON metrics (device_id, metric, instance, time);
