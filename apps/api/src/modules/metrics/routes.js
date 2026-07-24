/**
 * Metrics query API over TimescaleDB.
 *
 * The resolution is picked automatically from the requested range so charts
 * always hit the cheapest table: raw < 6h, 5m rollup < 7d, 1h rollup < 90d,
 * 1d rollup beyond — the UI never needs to know about aggregates.
 */

const SOURCES = [
  { maxRangeMs: 6 * 3600e3, table: 'metrics', timeCol: 'time', valueExpr: 'value AS avg_value, value AS max_value, value AS min_value' },
  { maxRangeMs: 7 * 86400e3, table: 'metrics_5m', timeCol: 'bucket', valueExpr: 'avg_value, max_value, min_value' },
  { maxRangeMs: 90 * 86400e3, table: 'metrics_1h', timeCol: 'bucket', valueExpr: 'avg_value, max_value, min_value' },
  { maxRangeMs: Infinity, table: 'metrics_1d', timeCol: 'bucket', valueExpr: 'avg_value, max_value, min_value' },
];

export default async function metricsRoutes(fastify) {
  fastify.get('/query', {
    schema: {
      querystring: {
        type: 'object',
        required: ['deviceId', 'metric'],
        properties: {
          deviceId: { type: 'string', format: 'uuid' },
          metric: { type: 'string', minLength: 1 },
          instance: { type: 'string' },
          from: { type: 'string' },   // ISO timestamp, default now-1h
          to: { type: 'string' },     // ISO timestamp, default now
        },
      },
    },
    preHandler: fastify.requireRole('viewer'),
  }, async (request, reply) => {
    const { deviceId, metric, instance } = request.query;
    const to = request.query.to ? new Date(request.query.to) : new Date();
    const from = request.query.from ? new Date(request.query.from) : new Date(to.getTime() - 3600e3);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
      return reply.code(400).send({ error: 'invalid time range' });
    }

    const source = SOURCES.find((s) => to - from <= s.maxRangeMs);
    const params = [deviceId, metric, from.toISOString(), to.toISOString()];
    let instanceClause = '';
    if (instance !== undefined) {
      params.push(instance);
      instanceClause = `AND instance = $${params.length}`;
    }

    const { rows } = await fastify.tsdb.query(
      `SELECT ${source.timeCol} AS time, instance, ${source.valueExpr}
       FROM ${source.table}
       WHERE device_id = $1 AND metric = $2
         AND ${source.timeCol} >= $3 AND ${source.timeCol} <= $4
         ${instanceClause}
       ORDER BY ${source.timeCol} ASC`,
      params,
    );
    return { source: source.table, series: rows };
  });

  /** Latest value per instance — powers gauges and top-N tables. */
  fastify.get('/latest', {
    schema: {
      querystring: {
        type: 'object',
        required: ['deviceId', 'metric'],
        properties: {
          deviceId: { type: 'string', format: 'uuid' },
          metric: { type: 'string', minLength: 1 },
        },
      },
    },
    preHandler: fastify.requireRole('viewer'),
  }, async (request) => {
    const { rows } = await fastify.tsdb.query(
      `SELECT DISTINCT ON (instance) instance, time, value
       FROM metrics
       WHERE device_id = $1 AND metric = $2 AND time > now() - INTERVAL '15 minutes'
       ORDER BY instance, time DESC`,
      [request.query.deviceId, request.query.metric],
    );
    return { values: rows };
  });

  /** Availability report from the state_changes log. */
  fastify.get('/availability', {
    schema: {
      querystring: {
        type: 'object',
        required: ['device'],
        properties: {
          device: { type: 'string', minLength: 1 },
          check: { type: 'string' },
          days: { type: 'integer', minimum: 1, maximum: 365, default: 30 },
        },
      },
    },
    preHandler: fastify.requireRole('viewer'),
  }, async (request) => {
    const { device, check = '', days } = request.query;
    const { rows } = await fastify.tsdb.query(
      `SELECT time, from_state, to_state, output
       FROM state_changes
       WHERE device_name = $1 AND check_name = $2 AND time > now() - make_interval(days => $3)
       ORDER BY time ASC`,
      [device, check, days],
    );

    // Integrate time spent in non-OK state between transitions.
    const now = Date.now();
    const windowStart = now - days * 86400e3;
    let downMs = 0;
    let cursor = windowStart;
    let currentBad = rows.length > 0 && rows[0].from_state !== 0;
    for (const row of rows) {
      const t = new Date(row.time).getTime();
      if (currentBad) downMs += t - cursor;
      cursor = t;
      currentBad = row.to_state !== 0;
    }
    if (currentBad) downMs += now - cursor;

    const totalMs = now - windowStart;
    return {
      device, check, days,
      availabilityPct: Number((100 * (1 - downMs / totalMs)).toFixed(4)),
      downtimeSeconds: Math.round(downMs / 1000),
      transitions: rows,
    };
  });
}
