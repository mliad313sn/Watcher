/**
 * Metrics query API over TimescaleDB.
 *
 * The resolution is picked automatically from the requested range so charts
 * always hit the cheapest table: raw < 6h, 5m rollup < 7d, 1h rollup < 90d,
 * 1d rollup beyond — the UI never needs to know about aggregates.
 */
import { REDIS_KEYS } from '@watcher/shared';
import { integrateDowntime } from './availability.js';

const SOURCES = [
  { maxRangeMs: 6 * 3600e3, table: 'metrics', timeCol: 'time', valueExpr: 'value AS avg_value, value AS max_value, value AS min_value' },
  { maxRangeMs: 7 * 86400e3, table: 'metrics_5m', timeCol: 'bucket', valueExpr: 'avg_value, max_value, min_value' },
  { maxRangeMs: 90 * 86400e3, table: 'metrics_1h', timeCol: 'bucket', valueExpr: 'avg_value, max_value, min_value' },
  { maxRangeMs: Infinity, table: 'metrics_1d', timeCol: 'bucket', valueExpr: 'avg_value, max_value, min_value' },
];

export default async function metricsRoutes(fastify) {
  // Metrics live in TimescaleDB (device_id only); ownership is defined in the
  // Postgres inventory. Verify the device belongs to the caller's tenant before
  // returning any series so metrics can't be read cross-tenant (issue #3).
  async function deviceInTenant(deviceId, tenantId) {
    const { rowCount } = await fastify.pg.query(
      'SELECT 1 FROM devices WHERE id = $1 AND tenant_id = $2 LIMIT 1', [deviceId, tenantId]);
    return rowCount > 0;
  }
  async function deviceNameInTenant(name, tenantId) {
    const { rowCount } = await fastify.pg.query(
      'SELECT 1 FROM devices WHERE name = $1 AND tenant_id = $2 LIMIT 1', [name, tenantId]);
    return rowCount > 0;
  }

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
    if (!(await deviceInTenant(deviceId, request.user.tenantId))) {
      return reply.code(404).send({ error: 'device not found' });
    }
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
  }, async (request, reply) => {
    if (!(await deviceInTenant(request.query.deviceId, request.user.tenantId))) {
      return reply.code(404).send({ error: 'device not found' });
    }
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
  }, async (request, reply) => {
    const { device, check = '', days } = request.query;
    if (!(await deviceNameInTenant(device, request.user.tenantId))) {
      return reply.code(404).send({ error: 'device not found' });
    }
    const now = Date.now();
    const windowStart = now - days * 86400e3;
    const windowStartIso = new Date(windowStart).toISOString();

    const [inWindow, prior] = await Promise.all([
      fastify.tsdb.query(
        `SELECT time, from_state, to_state, output
         FROM state_changes
         WHERE device_name = $1 AND check_name = $2 AND time >= $3
         ORDER BY time ASC`,
        [device, check, windowStartIso],
      ),
      // The state at the START of the window = to_state of the last transition
      // strictly before it. Without this, a device that was already down before
      // the window (and never transitioned inside it) wrongly reported 100%.
      fastify.tsdb.query(
        `SELECT to_state
         FROM state_changes
         WHERE device_name = $1 AND check_name = $2 AND time < $3
         ORDER BY time DESC LIMIT 1`,
        [device, check, windowStartIso],
      ),
    ]);
    const rows = inWindow.rows;

    // Seed the window's opening state, most-reliable source first:
    //   1. last transition before the window,
    //   2. the from_state of the first in-window transition,
    //   3. the object's current live state (Redis) as a last resort.
    let initialBad;
    if (prior.rows.length) {
      initialBad = prior.rows[0].to_state !== 0;
    } else if (rows.length) {
      initialBad = rows[0].from_state !== 0;
    } else {
      const stateKey = check
        ? REDIS_KEYS.serviceState(device, check)
        : REDIS_KEYS.hostState(device);
      const cur = await fastify.redis.hget(stateKey, 'state');
      initialBad = cur != null ? Number(cur) !== 0 : false;
    }

    // Integrate time spent in non-OK state between transitions.
    const downMs = integrateDowntime({
      transitions: rows, initialBad, windowStartMs: windowStart, nowMs: now,
    });

    const totalMs = now - windowStart;
    return {
      device, check, days,
      availabilityPct: Number((100 * (1 - downMs / totalMs)).toFixed(4)),
      downtimeSeconds: Math.round(downMs / 1000),
      transitions: rows,
    };
  });

  /**
   * Fleet-wide SLA: host availability for every device in the tenant over the
   * window, one pass over state_changes. `format=csv` streams a download for
   * the monthly-report ritual (parity with Nagios XI Enterprise / OpManager).
   */
  fastify.get('/sla', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          days: { type: 'integer', minimum: 1, maximum: 365, default: 30 },
          format: { type: 'string', enum: ['json', 'csv'], default: 'json' },
        },
      },
    },
    preHandler: fastify.requireRole('viewer'),
  }, async (request, reply) => {
    const { days, format } = request.query;
    const now = Date.now();
    const windowStart = now - days * 86400e3;
    const windowStartIso = new Date(windowStart).toISOString();
    const tenantId = request.user.tenantId;

    const { rows: devices } = await fastify.pg.query(
      'SELECT name, kind FROM devices WHERE tenant_id = $1 ORDER BY name', [tenantId]);
    if (devices.length === 0) return { days, rows: [] };
    const names = devices.map((d) => d.name);

    // One query for all in-window host transitions, one for each device's
    // opening state — instead of 2N round-trips.
    const [inWindow, priors] = await Promise.all([
      fastify.tsdb.query(
        `SELECT device_name, time, from_state, to_state
         FROM state_changes
         WHERE device_name = ANY($1) AND check_name = '' AND time >= $2
         ORDER BY device_name, time ASC`,
        [names, windowStartIso]),
      fastify.tsdb.query(
        `SELECT DISTINCT ON (device_name) device_name, to_state
         FROM state_changes
         WHERE device_name = ANY($1) AND check_name = '' AND time < $2
         ORDER BY device_name, time DESC`,
        [names, windowStartIso]),
    ]);

    const byDevice = new Map(names.map((n) => [n, []]));
    for (const r of inWindow.rows) byDevice.get(r.device_name)?.push(r);
    const priorBad = new Map(priors.rows.map((r) => [r.device_name, r.to_state !== 0]));

    const totalMs = now - windowStart;
    const report = devices.map((d) => {
      const transitions = byDevice.get(d.name) ?? [];
      const initialBad = priorBad.has(d.name)
        ? priorBad.get(d.name)
        : (transitions.length ? transitions[0].from_state !== 0 : false);
      const downMs = integrateDowntime({
        transitions, initialBad, windowStartMs: windowStart, nowMs: now,
      });
      return {
        device: d.name,
        kind: d.kind,
        availabilityPct: Number((100 * (1 - downMs / totalMs)).toFixed(4)),
        downtimeSeconds: Math.round(downMs / 1000),
        outages: transitions.filter((t) => t.to_state !== 0).length,
      };
    }).sort((a, b) => a.availabilityPct - b.availabilityPct); // worst first

    if (format === 'csv') {
      const headRow = 'device,kind,availability_pct,downtime_seconds,outages';
      const lines = report.map((r) =>
        // Device names come from operators; quote so a comma can't shift columns.
        `"${r.device.replaceAll('"', '""')}",${r.kind},${r.availabilityPct},${r.downtimeSeconds},${r.outages}`);
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition',
          `attachment; filename="watcher-sla-${days}d-${new Date().toISOString().slice(0, 10)}.csv"`)
        .send([headRow, ...lines].join('\n') + '\n');
    }
    return { days, rows: report };
  });

  /**
   * Push ingest for agents and integrations (pairs with scoped API tokens:
   * send X-API-Token). The device is addressed by NAME so an agent needs no
   * UUID knowledge; it must already exist in the caller's tenant inventory.
   */
  fastify.post('/ingest', {
    schema: {
      body: {
        type: 'object',
        required: ['device', 'metrics'],
        properties: {
          device: { type: 'string', minLength: 1 },
          metrics: {
            type: 'array', minItems: 1, maxItems: 500,
            items: {
              type: 'object',
              required: ['metric', 'value'],
              properties: {
                metric: { type: 'string', minLength: 1, maxLength: 120 },
                value: { type: 'number' },
                instance: { type: 'string', maxLength: 120 },
                time: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
    },
    preHandler: fastify.requireRole('operator'),
  }, async (request, reply) => {
    const { device, metrics } = request.body;
    const { rows } = await fastify.pg.query(
      'SELECT id FROM devices WHERE name = $1 AND tenant_id = $2',
      [device, request.user.tenantId]);
    if (!rows[0]) return reply.code(404).send({ error: `device "${device}" not in inventory` });
    const deviceId = rows[0].id;

    const params = [];
    const tuples = metrics.map((m, i) => {
      const o = i * 5;
      params.push(m.time ?? new Date().toISOString(), deviceId, m.metric, m.instance ?? '', m.value);
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5})`;
    });
    await fastify.tsdb.query(
      `INSERT INTO metrics (time, device_id, metric, instance, value)
       VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`,
      params);

    // Live tick so open charts update without waiting for the next poll.
    fastify.redis.publish(REDIS_KEYS.eventsMetrics, JSON.stringify({
      deviceId, samples: metrics.map((m) => ({ metric: m.metric, instance: m.instance ?? '', value: m.value })),
      ts: Date.now(),
    })).catch(() => {});

    return { ok: true, accepted: metrics.length };
  });
}
