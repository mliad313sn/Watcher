/**
 * Status components: a curated, audience-facing rollup of fleet health.
 *   GET  /api/status/public   — UNAUTHENTICATED; sanitized (names + status only)
 *   GET/POST/DELETE /api/status/components — tenant-scoped management
 */
import { REDIS_KEYS } from '@watcher/shared';
import { publicMaintenanceNotice } from '../maintenance/routes.js';

const RANK = { operational: 0, degraded: 1, major_outage: 2 };
const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);

/** Roll up a set of live-state objects into a component status. */
function rollup(objects) {
  let status = 'operational';
  for (const o of objects) {
    const s = Number(o.state);
    if (o.kind === 'host') {
      if (s === 1) status = worst(status, 'major_outage');       // DOWN
      else if (s === 2) status = worst(status, 'degraded');      // UNREACHABLE
    } else {
      if (s === 2) status = worst(status, 'major_outage');       // CRITICAL
      else if (s === 1 || s === 3) status = worst(status, 'degraded'); // WARN/UNKNOWN
    }
  }
  return status;
}

function deviceMatches(device, match) {
  if (match.kind && device.kind !== match.kind) return false;
  if (match.tags) {
    for (const [k, v] of Object.entries(match.tags)) {
      if ((device.tags ?? {})[k] !== v) return false;
    }
  }
  return true;
}

/** Read the tenant's live host/service state from Redis. */
async function tenantState(fastify, tenantId) {
  const keys = await fastify.redis.smembers(REDIS_KEYS.stateIndex);
  if (keys.length === 0) return [];
  const pipe = fastify.redis.pipeline();
  for (const k of keys) pipe.hgetall(k);
  const res = await pipe.exec();
  return res
    .map(([err, h]) => (err || !h?.kind ? null : h))
    .filter((h) => h && (!h.tenantId || h.tenantId === tenantId));
}

async function buildStatus(fastify, tenantId) {
  const [{ rows: components }, { rows: devices }, state] = await Promise.all([
    fastify.pg.query('SELECT name, match FROM status_components WHERE tenant_id = $1 ORDER BY position, name', [tenantId]),
    fastify.pg.query('SELECT name, kind, tags FROM devices WHERE tenant_id = $1 AND monitored', [tenantId]),
    tenantState(fastify, tenantId),
  ]);

  const stateByHost = new Map();
  for (const o of state) {
    if (!stateByHost.has(o.host)) stateByHost.set(o.host, []);
    stateByHost.get(o.host).push(o);
  }

  const out = components.map((c) => {
    const hosts = devices.filter((d) => deviceMatches(d, c.match ?? {}));
    const objs = hosts.flatMap((h) => stateByHost.get(h.name) ?? []);
    const status = rollup(objs);
    const impacted = new Set(objs.filter((o) => Number(o.state) !== 0).map((o) => o.host)).size;
    return { name: c.name, status, devices: hosts.length, impacted };
  });

  const overall = out.reduce((acc, c) => worst(acc, c.status), 'operational');
  return { generatedAt: new Date().toISOString(), overall, components: out };
}

export default async function statusRoutes(fastify) {
  // Public, unauthenticated status board. Only names + rolled-up status leave
  // the building — never hostnames, IPs, or messages.
  fastify.get('/public', {
    schema: { querystring: { type: 'object', properties: { tenant: { type: 'string' } } } },
  }, async (request, reply) => {
    const tenantName = request.query.tenant ?? 'default';
    const { rows } = await fastify.pg.query('SELECT id FROM tenants WHERE name = $1', [tenantName]);
    if (rows.length === 0) return reply.code(404).send({ error: 'unknown status page' });
    reply.header('cache-control', 'public, max-age=15');
    const [status, maintenance] = await Promise.all([
      buildStatus(fastify, rows[0].id),
      publicMaintenanceNotice(fastify.pg, rows[0].id),
    ]);
    // Sanitized: only the window's name and times reach the public page.
    return {
      tenant: tenantName,
      ...status,
      maintenance: maintenance
        ? { name: maintenance.name, startsAt: maintenance.starts_at,
            endsAt: maintenance.ends_at, active: maintenance.active }
        : null,
    };
  });

  fastify.get('/components', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    const { rows } = await fastify.pg.query(
      'SELECT * FROM status_components WHERE tenant_id = $1 ORDER BY position, name', [request.user.tenantId]);
    return { components: rows };
  });

  fastify.post('/components', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          match: { type: 'object' },
          position: { type: 'integer', minimum: 0 },
        },
      },
    },
    preHandler: fastify.requireRole('admin'),
  }, async (request, reply) => {
    const b = request.body;
    const { rows } = await fastify.pg.query(
      `INSERT INTO status_components (tenant_id, name, match, position)
       VALUES ($1, $2, COALESCE($3,'{}'::jsonb), COALESCE($4, 0))
       ON CONFLICT (tenant_id, name) DO UPDATE SET match = EXCLUDED.match, position = EXCLUDED.position
       RETURNING *`,
      [request.user.tenantId, b.name, b.match ? JSON.stringify(b.match) : null, b.position ?? null]);
    return reply.code(201).send({ component: rows[0] });
  });

  fastify.delete('/components/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
    preHandler: fastify.requireRole('admin'),
  }, async (request, reply) => {
    const { rowCount } = await fastify.pg.query(
      'DELETE FROM status_components WHERE id = $1 AND tenant_id = $2', [request.params.id, request.user.tenantId]);
    if (rowCount === 0) return reply.code(404).send({ error: 'not found' });
    return reply.code(204).send();
  });
}
