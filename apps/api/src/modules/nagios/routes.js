/**
 * Nagios routes: live state reads (from the Redis cache) and operator
 * actions (acknowledge / re-check / downtime) via the external command file.
 */
import { REDIS_KEYS } from '@watcher/shared';
import { NagiosCommandWriter } from './external-command.js';

export default async function nagiosRoutes(fastify, opts) {
  const commands = new NagiosCommandWriter(opts.nagios.commandFile);

  /** Full live state dump — grids and the status map read this once, then
   *  stay current via the WebSocket state stream. */
  fastify.get('/state', { preHandler: fastify.requireRole('viewer') }, async () => {
    const keys = await fastify.redis.smembers(REDIS_KEYS.stateIndex);
    if (keys.length === 0) return { hosts: [], services: [] };

    const pipeline = fastify.redis.pipeline();
    for (const key of keys) pipeline.hgetall(key);
    const results = await pipeline.exec();

    const hosts = [];
    const services = [];
    for (const [err, hash] of results) {
      if (err || !hash?.kind) continue;
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
  fastify.get('/summary', { preHandler: fastify.requireRole('viewer') }, async () => {
    const keys = await fastify.redis.smembers(REDIS_KEYS.stateIndex);
    const pipeline = fastify.redis.pipeline();
    for (const key of keys) pipeline.hmget(key, 'kind', 'state', 'acknowledged', 'inDowntime');
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
      const [kind, state, ack, downtime] = row;
      if (kind === 'host') summary.hosts[HOST_BUCKETS[Number(state)] ?? 'down'] += 1;
      else if (kind === 'service') summary.services[SVC_BUCKETS[Number(state)] ?? 'unknown'] += 1;
      if (ack === '1') summary.acknowledged += 1;
      if (downtime === '1') summary.inDowntime += 1;
    }
    return summary;
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
    async (request) => {
      const { host, service, comment } = request.body;
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
  }, async (request) => {
    const { host, service } = request.body;
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
  }, async (request) => {
    const { host, service, minutes, comment } = request.body;
    const start = Math.floor(Date.now() / 1000);
    const end = start + minutes * 60;
    const user = request.user.username;
    const line = service
      ? await commands.scheduleServiceDowntime(host, service, start, end, user, comment)
      : await commands.scheduleHostDowntime(host, start, end, user, comment);
    return { ok: true, command: line };
  });
}
