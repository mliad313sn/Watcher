/**
 * Nagios routes: live state reads (from the Redis cache) and operator
 * actions (acknowledge / re-check / downtime) via the external command file.
 */
import { REDIS_KEYS } from '@watcher/shared';
import { NagiosCommandWriter } from './external-command.js';

export default async function nagiosRoutes(fastify, opts) {
  const commands = new NagiosCommandWriter(opts.nagios.commandFile);

  // Operator actions target a host by name; ensure it belongs to the caller's
  // tenant so one tenant can't ack/recheck/downtime another's hosts (issue #3).
  async function hostInTenant(host, tenantId) {
    const { rowCount } = await fastify.pg.query(
      'SELECT 1 FROM devices WHERE name = $1 AND tenant_id = $2 LIMIT 1', [host, tenantId]);
    return rowCount > 0;
  }

  /** Full live state dump — grids and the status map read this once, then
   *  stay current via the WebSocket state stream. */
  fastify.get('/state', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    const tenantId = request.user.tenantId;
    const keys = await fastify.redis.smembers(REDIS_KEYS.stateIndex);
    if (keys.length === 0) return { hosts: [], services: [] };

    const pipeline = fastify.redis.pipeline();
    for (const key of keys) pipeline.hgetall(key);
    const results = await pipeline.exec();

    const hosts = [];
    const services = [];
    for (const [err, hash] of results) {
      if (err || !hash?.kind) continue;
      // Tenant isolation: never leak another tenant's objects (issue #3).
      if (hash.tenantId && hash.tenantId !== tenantId) continue;
      const obj = {
        ...hash,
        state: Number(hash.state),
        hard: hash.hard === '1',
        flapping: hash.flapping === '1',
        acknowledged: hash.acknowledged === '1',
        inDowntime: hash.inDowntime === '1',
        lastCheck: Number(hash.lastCheck),
        lastStateChange: Number(hash.lastStateChange),
      };
      (obj.kind === 'host' ? hosts : services).push(obj);
    }
    return { hosts, services };
  });

  /** Rolled-up counts for the topbar / summary tiles. */
  fastify.get('/summary', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    const tenantId = request.user.tenantId;
    const keys = await fastify.redis.smembers(REDIS_KEYS.stateIndex);
    const pipeline = fastify.redis.pipeline();
    for (const key of keys) pipeline.hmget(key, 'kind', 'state', 'acknowledged', 'inDowntime', 'tenantId');
    const results = await pipeline.exec();

    const summary = {
      hosts: { up: 0, down: 0, unreachable: 0 },
      services: { ok: 0, warning: 0, critical: 0, unknown: 0 },
      acknowledged: 0,
      inDowntime: 0,
    };
    const HOST_BUCKETS = ['up', 'down', 'unreachable'];
    const SVC_BUCKETS = ['ok', 'warning', 'critical', 'unknown'];
    for (const [err, row] of results) {
      if (err || !row) continue;
      const [kind, state, ack, downtime, objTenant] = row;
      if (objTenant && objTenant !== tenantId) continue; // tenant isolation (#3)
      if (kind === 'host') summary.hosts[HOST_BUCKETS[Number(state)] ?? 'down'] += 1;
      else if (kind === 'service') summary.services[SVC_BUCKETS[Number(state)] ?? 'unknown'] += 1;
      if (ack === '1') summary.acknowledged += 1;
      if (downtime === '1') summary.inDowntime += 1;
    }
    return summary;
  });

  /**
   * Recent event history so the live feed is never blank when there IS a story
   * to tell (time-to-value / "is this thing on?"). Merges the last state
   * transitions (from state_changes, scoped to the tenant's devices) with
   * recent alert transitions, newest first. The WebSocket stream then prepends
   * live events on top of this baseline.
   */
  fastify.get('/events/recent', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    const tenantId = request.user.tenantId;
    const limit = Math.min(Number(request.query?.limit) || 60, 200);
    const HOST = ['up', 'down', 'unreachable'];
    const SVC = ['ok', 'warning', 'critical', 'unknown'];
    const HOST_NAME = ['UP', 'DOWN', 'UNREACHABLE'];
    const SVC_NAME = ['OK', 'WARNING', 'CRITICAL', 'UNKNOWN'];

    const [changes, alerts] = await Promise.all([
      fastify.pg.query(
        `SELECT sc.time, sc.device_name, sc.check_name, sc.to_state, sc.output
           FROM state_changes sc
           JOIN devices d ON d.name = sc.device_name AND d.tenant_id = $1
          ORDER BY sc.time DESC
          LIMIT $2`, [tenantId, limit]),
      fastify.pg.query(
        `SELECT device_name, check_name, severity, status, message, updated_at
           FROM alerts
          WHERE tenant_id = $1
          ORDER BY updated_at DESC
          LIMIT $2`, [tenantId, limit]),
    ]);

    const events = [];
    for (const r of changes.rows) {
      const isHost = !r.check_name;
      const cls = isHost ? (HOST[r.to_state] ?? 'unknown') : (SVC[r.to_state] ?? 'unknown');
      const stateName = isHost ? (HOST_NAME[r.to_state] ?? '?') : (SVC_NAME[r.to_state] ?? '?');
      events.push({
        ts: new Date(r.time).getTime(),
        chipClass: cls,
        severity: cls,
        title: `${r.device_name}${r.check_name ? ' / ' + r.check_name : ''} → ${stateName}`,
        detail: r.output || '',
      });
    }
    for (const a of alerts.rows) {
      const resolved = a.status === 'resolved';
      events.push({
        ts: new Date(a.updated_at).getTime(),
        chipClass: resolved ? 'ok' : (a.status === 'suppressed' ? 'suppressed' : a.severity),
        severity: a.severity,
        title: `alert ${a.status}: ${a.device_name}${a.check_name ? ' / ' + a.check_name : ''}`,
        detail: a.message || '',
      });
    }
    events.sort((x, y) => y.ts - x.ts);
    return { events: events.slice(0, limit) };
  });

  const ackSchema = {
    body: {
      type: 'object',
      required: ['host', 'comment'],
      properties: {
        host: { type: 'string', minLength: 1 },
        service: { type: 'string' },
        comment: { type: 'string', minLength: 1 },
      },
    },
  };

  fastify.post('/ack', { schema: ackSchema, preHandler: fastify.requireRole('operator') },
    async (request, reply) => {
      const { host, service, comment } = request.body;
      if (!(await hostInTenant(host, request.user.tenantId))) {
        return reply.code(403).send({ error: 'host not in your tenant' });
      }
      const user = request.user.username;
      const line = service
        ? await commands.acknowledgeService(host, service, user, comment)
        : await commands.acknowledgeHost(host, user, comment);
      return { ok: true, command: line };
    });

  fastify.post('/recheck', {
    schema: {
      body: {
        type: 'object',
        required: ['host'],
        properties: { host: { type: 'string', minLength: 1 }, service: { type: 'string' } },
      },
    },
    preHandler: fastify.requireRole('operator'),
  }, async (request, reply) => {
    const { host, service } = request.body;
    if (!(await hostInTenant(host, request.user.tenantId))) {
      return reply.code(403).send({ error: 'host not in your tenant' });
    }
    const line = service
      ? await commands.recheckService(host, service)
      : await commands.recheckHost(host);
    return { ok: true, command: line };
  });

  fastify.post('/downtime', {
    schema: {
      body: {
        type: 'object',
        required: ['host', 'minutes', 'comment'],
        properties: {
          host: { type: 'string', minLength: 1 },
          service: { type: 'string' },
          minutes: { type: 'integer', minimum: 1, maximum: 60 * 24 * 30 },
          comment: { type: 'string', minLength: 1 },
        },
      },
    },
    preHandler: fastify.requireRole('operator'),
  }, async (request, reply) => {
    const { host, service, minutes, comment } = request.body;
    if (!(await hostInTenant(host, request.user.tenantId))) {
      return reply.code(403).send({ error: 'host not in your tenant' });
    }
    const start = Math.floor(Date.now() / 1000);
    const end = start + minutes * 60;
    const user = request.user.username;
    const line = service
      ? await commands.scheduleServiceDowntime(host, service, start, end, user, comment)
      : await commands.scheduleHostDowntime(host, start, end, user, comment);
    return { ok: true, command: line };
  });
}
