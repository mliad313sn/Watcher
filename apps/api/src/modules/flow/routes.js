/**
 * Flow analytics — "who is using the bandwidth", which is the question
 * everybody asks immediately after "is it up".
 *
 *   GET /api/flow/talkers       top hosts by volume
 *   GET /api/flow/conversations top host pairs
 *   GET /api/flow/services      volume by application
 *   GET /api/flow/interfaces    volume by exporter interface
 *   GET /api/flow/series        one series for a chart
 *
 * Every route reads the pre-folded `flows` table (or the hourly service
 * rollup for long windows). There is no raw flow record to query: the
 * collector aggregates at ingest because per-conversation records at line
 * rate are orders of magnitude beyond what the write path can take. What
 * that costs is stated in the schema and in docs/EVENTS.md rather than
 * discovered — per-session forensics is not on offer here.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Windows longer than this read the hourly rollup instead of raw rows. */
export const ROLLUP_AFTER_HOURS = 48;

/** Bound the window so one query cannot ask for the whole retention at once. */
export function windowHours(query) {
  const hours = Number(query?.hours ?? 24);
  if (!Number.isFinite(hours)) return 24;
  return Math.min(Math.max(hours, 1), 24 * 14);
}

export function limitOf(query, fallback = 20) {
  const limit = Number(query?.limit ?? fallback);
  if (!Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(limit, 1), 200);
}

export default async function flowRoutes(fastify) {
  /** Constrain every query to the caller's tenant, and optionally one device. */
  function scope(request, params) {
    params.push(request.user.tenantId);
    let where = `tenant_id = $${params.length}`;
    /* A device filter that is not a uuid must not reach Postgres, where it
       becomes a 22P02 and a 500 for what is really a bad request. */
    if (request.query?.device && UUID_RE.test(request.query.device)) {
      params.push(request.query.device);
      where += ` AND device_id = $${params.length}`;
    }
    return where;
  }

  /**
   * Top talkers. A conversation is stored once with its endpoints ordered,
   * so a host's total is the sum of the rows where it appears on either
   * side — which the UNION below does rather than double counting.
   */
  fastify.get('/talkers', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    const hours = windowHours(request.query);
    const params = [];
    const where = scope(request, params);
    const hoursAt = params.push(hours);
    const limitAt = params.push(limitOf(request.query));

    const { rows } = await fastify.tsdb.query(
      `WITH endpoints AS (
         SELECT host(src_addr) AS addr, bytes, packets FROM flows
          WHERE ${where} AND time >= now() - ($${hoursAt} || ' hours')::interval
         UNION ALL
         SELECT host(dst_addr) AS addr, bytes, packets FROM flows
          WHERE ${where} AND time >= now() - ($${hoursAt} || ' hours')::interval
       )
       SELECT addr, sum(bytes)::bigint AS bytes, sum(packets)::bigint AS packets
         FROM endpoints
        GROUP BY addr
        ORDER BY bytes DESC
        LIMIT $${limitAt}`,
      params);
    return { hours, talkers: rows };
  });

  /** Top conversations — the pair, not the host. */
  fastify.get('/conversations', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    const hours = windowHours(request.query);
    const params = [];
    const where = scope(request, params);
    const hoursAt = params.push(hours);
    const limitAt = params.push(limitOf(request.query));

    const { rows } = await fastify.tsdb.query(
      `SELECT host(src_addr) AS src, host(dst_addr) AS dst, service, protocol,
              sum(bytes)::bigint AS bytes, sum(packets)::bigint AS packets
         FROM flows
        WHERE ${where} AND time >= now() - ($${hoursAt} || ' hours')::interval
        GROUP BY src, dst, service, protocol
        ORDER BY bytes DESC
        LIMIT $${limitAt}`,
      params);
    return { hours, conversations: rows };
  });

  /**
   * Volume by application. Long windows read the hourly rollup — it is kept
   * a year precisely so "what does backup cost us every night" survives the
   * fourteen-day conversation retention.
   */
  fastify.get('/services', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    const hours = windowHours(request.query);
    const rolled = hours > ROLLUP_AFTER_HOURS;
    const params = [];
    const where = scope(request, params);
    const hoursAt = params.push(hours);
    const limitAt = params.push(limitOf(request.query));

    const { rows } = await fastify.tsdb.query(
      rolled
        ? `SELECT service, sum(bytes)::bigint AS bytes, sum(packets)::bigint AS packets
             FROM flows_service_1h
            WHERE ${where} AND bucket >= now() - ($${hoursAt} || ' hours')::interval
            GROUP BY service ORDER BY bytes DESC LIMIT $${limitAt}`
        : `SELECT service, sum(bytes)::bigint AS bytes, sum(packets)::bigint AS packets
             FROM flows
            WHERE ${where} AND time >= now() - ($${hoursAt} || ' hours')::interval
            GROUP BY service ORDER BY bytes DESC LIMIT $${limitAt}`,
      params);
    return { hours, source: rolled ? 'rollup' : 'detail', services: rows };
  });

  /** Volume per exporter interface, joined to inventory for a readable name. */
  fastify.get('/interfaces', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    const hours = windowHours(request.query);
    const params = [];
    const where = scope(request, params);
    const hoursAt = params.push(hours);
    const limitAt = params.push(limitOf(request.query));

    const { rows } = await fastify.tsdb.query(
      `SELECT device_id, if_index,
              sum(bytes)::bigint AS bytes, sum(packets)::bigint AS packets,
              count(*)::bigint   AS conversations
         FROM flows
        WHERE ${where} AND time >= now() - ($${hoursAt} || ' hours')::interval
        GROUP BY device_id, if_index
        ORDER BY bytes DESC
        LIMIT $${limitAt}`,
      params);

    // The metrics store holds no device names; naming happens here.
    const ids = [...new Set(rows.map((r) => r.device_id).filter(Boolean))];
    const names = new Map();
    if (ids.length) {
      const { rows: devices } = await fastify.pg.query(
        'SELECT id, name FROM devices WHERE id = ANY($1::uuid[]) AND tenant_id = $2',
        [ids, request.user.tenantId]);
      for (const d of devices) names.set(d.id, d.name);
    }
    return {
      hours,
      interfaces: rows.map((r) => ({ ...r, device_name: names.get(r.device_id) ?? null })),
    };
  });

  /** A time series for one chart: total, or one service, bucketed. */
  fastify.get('/series', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    const hours = windowHours(request.query);
    // Aim for roughly 120 points whatever the window, rounded to a minute.
    const bucketMinutes = Math.max(1, Math.round((hours * 60) / 120));
    // Placeholder positions are captured as each value is pushed. Counting
    // backwards from params.length is how an optional filter silently
    // shifts every other parameter by one.
    const params = [];
    const where = scope(request, params);
    const hoursAt = params.push(hours);
    const bucketAt = params.push(`${bucketMinutes} minutes`);
    let filter = '';
    if (request.query?.service) {
      filter = ` AND service = $${params.push(request.query.service)}`;
    }

    const { rows } = await fastify.tsdb.query(
      `SELECT time_bucket($${bucketAt}::interval, time) AS bucket,
              sum(bytes)::bigint AS bytes, sum(packets)::bigint AS packets
         FROM flows
        WHERE ${where} AND time >= now() - ($${hoursAt} || ' hours')::interval${filter}
        GROUP BY bucket
        ORDER BY bucket`,
      params);
    return { hours, bucketMinutes, points: rows };
  });
}
