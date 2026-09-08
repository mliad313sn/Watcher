-- Flow store: folded conversations from NetFlow, IPFIX and sFlow.
--
-- These rows are ALREADY aggregated. The collector folds records in memory
-- over a flush interval (default one minute) and writes one row per
-- conversation key, because a busy edge router exports tens of thousands of
-- conversations a minute and storing them raw is a write path that falls
-- over on the first real link.
--
-- What that costs, stated plainly: per-flow forensics is not available here.
-- You can answer "who filled the link, over what, through which interface,
-- and when" — which is what a flow view is asked — and you cannot answer
-- "show me every individual TCP session from that host". A product that
-- needs the second answer needs a dedicated flow appliance, and should say
-- so rather than pretend.

CREATE TABLE flows (
    time        timestamptz NOT NULL,        -- the flush interval's end
    tenant_id   uuid        NOT NULL,
    device_id   uuid,                        -- the exporter, when we know it
    exporter    inet,
    src_addr    inet        NOT NULL,
    dst_addr    inet        NOT NULL,
    protocol    smallint    NOT NULL DEFAULT 0,
    -- Named from the well-known port of the pair, or the protocol when
    -- neither port is one we recognise. Never a guess dressed as a fact.
    service     text        NOT NULL DEFAULT '',
    if_index    integer     NOT NULL DEFAULT 0,
    bytes       bigint      NOT NULL DEFAULT 0,
    packets     bigint      NOT NULL DEFAULT 0
);

SELECT create_hypertable('flows', by_range('time', INTERVAL '1 day'));
SELECT add_dimension('flows', by_hash('tenant_id', 4));

-- The three questions: what is this device carrying, who is this talker
-- talking to, and what is this service costing.
CREATE INDEX flows_device_time_idx  ON flows (device_id, time DESC);
CREATE INDEX flows_src_time_idx     ON flows (tenant_id, src_addr, time DESC);
CREATE INDEX flows_service_time_idx ON flows (tenant_id, service, time DESC);

ALTER TABLE flows SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'tenant_id, device_id',
    timescaledb.compress_orderby   = 'time DESC, bytes DESC'
);
SELECT add_compression_policy('flows', INTERVAL '2 days');

-- Fourteen days of conversation detail. Long enough to investigate last
-- week's saturation, short enough that the table has a ceiling.
SELECT add_retention_policy('flows', INTERVAL '14 days');

-- ── the long view ──────────────────────────────────────────────────────────
-- Per service and interface, hourly, kept a year. Capacity planning asks
-- "what does backup cost us every night", and that question outlives the
-- conversation detail that answered it the first time.
CREATE MATERIALIZED VIEW flows_service_1h
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', time) AS bucket,
       tenant_id, device_id, service, if_index,
       sum(bytes)::bigint   AS bytes,
       sum(packets)::bigint AS packets,
       count(*)::bigint     AS conversations
FROM flows
GROUP BY bucket, tenant_id, device_id, service, if_index
WITH NO DATA;

SELECT add_continuous_aggregate_policy('flows_service_1h',
    start_offset => INTERVAL '3 hours',
    end_offset   => INTERVAL '1 hour',
    schedule_interval => INTERVAL '30 minutes');
SELECT add_retention_policy('flows_service_1h', INTERVAL '1 year');
