/**
 * Application factory — builds and wires the Fastify instance.
 * Split from server.js so tests can build an app without binding a port.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { REDIS_KEYS } from '@watcher/shared';

import dbPlugin from './plugins/db.js';
import redisPlugin from './plugins/redis.js';
import authPlugin from './plugins/auth.js';
import wsHub from './ws/hub.js';

import authRoutes from './modules/auth/routes.js';
import nagiosRoutes from './modules/nagios/routes.js';
import alertRoutes from './modules/alerts/routes.js';
import metricsRoutes from './modules/metrics/routes.js';
import deviceRoutes from './modules/devices/routes.js';
import dashboardRoutes from './modules/dashboards/routes.js';
import discoveryRoutes from './modules/discovery/routes.js';
import demoRoutes from './modules/demo/routes.js';
import oncallRoutes from './modules/oncall/routes.js';

import { NagiosStreamer } from './modules/nagios/streamer.js';
import { CorrelationEngine } from './modules/alerts/correlation-engine.js';
import { NotifierEngine } from './modules/alerts/notifier.js';

const INSECURE_JWT_SECRETS = new Set(['dev-only-secret', 'change-me-in-production']);

export async function buildApp(config, { withBackgroundJobs = true } = {}) {
  // Fail fast rather than silently issuing forgeable tokens in production (#4).
  if (process.env.NODE_ENV === 'production'
      && (!config.jwt.secret || INSECURE_JWT_SECRETS.has(config.jwt.secret) || config.jwt.secret.length < 32)) {
    throw new Error(
      'JWT_SECRET must be set to a strong (>=32 char) non-default value in production. '
      + 'Generate one with: openssl rand -hex 32');
  }

  const fastify = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
  });

  await fastify.register(cors, { origin: config.corsOrigins, credentials: true });
  await fastify.register(dbPlugin, { pg: config.pg, tsdb: config.tsdb });
  await fastify.register(redisPlugin, { url: config.redisUrl });
  await fastify.register(authPlugin, { secret: config.jwt.secret, ttl: config.jwt.ttl });
  await fastify.register(wsHub);

  // Liveness: the process is up. Cheap, never touches dependencies.
  fastify.get('/healthz', async () => ({ ok: true, uptime: process.uptime() }));

  // Readiness: dependencies are reachable AND the monitoring engine is fresh.
  // Returns 503 when unhealthy so orchestrators pull the pod from rotation and
  // the platform never reports "ready" while blind (issue #2).
  fastify.get('/readyz', async (request, reply) => {
    const checks = {};
    const probe = async (name, fn) => {
      try { await fn(); checks[name] = 'ok'; }
      catch (err) { checks[name] = `error: ${err.message}`; }
    };
    await Promise.all([
      probe('postgres', () => fastify.pg.query('SELECT 1')),
      probe('timescaledb', () => fastify.tsdb.query('SELECT 1')),
      probe('redis', () => fastify.redis.ping()),
    ]);
    // Nagios data freshness (heartbeat is status.dat's mtime in ms).
    const beat = Number(await fastify.redis.get(REDIS_KEYS.nagiosHeartbeat));
    const ageMs = beat ? Date.now() - beat : Infinity;
    const staleMs = config.nagios.staleThresholdMs ?? Math.max(30_000, config.nagios.pollInterval * 4);
    checks.nagios = beat
      ? (ageMs <= staleMs ? 'ok' : `stale: ${Math.round(ageMs / 1000)}s`)
      : 'no heartbeat yet';

    const ready = Object.values(checks).every((v) => v === 'ok');
    return reply.code(ready ? 200 : 503).send({ ready, checks });
  });

  await fastify.register(authRoutes, { prefix: '/api/auth' });
  await fastify.register(nagiosRoutes, { prefix: '/api/nagios', nagios: config.nagios });
  await fastify.register(alertRoutes, { prefix: '/api/alerts' });
  await fastify.register(metricsRoutes, { prefix: '/api/metrics' });
  await fastify.register(deviceRoutes, { prefix: '/api/devices' });
  await fastify.register(dashboardRoutes, { prefix: '/api/dashboards' });
  await fastify.register(discoveryRoutes, { prefix: '/api/discovery' });
  await fastify.register(demoRoutes, { prefix: '/api/demo' });
  await fastify.register(oncallRoutes, { prefix: '/api/oncall' });

  if (withBackgroundJobs) {
    const streamer = new NagiosStreamer(
      { redis: fastify.redis, pg: fastify.pg, tsdb: fastify.tsdb, log: fastify.log },
      config.nagios,
    );
    const correlator = new CorrelationEngine({
      redis: fastify.redis,
      redisSub: fastify.redisSub,
      pg: fastify.pg,
      log: fastify.log,
    });
    const notifier = new NotifierEngine(
      { redis: fastify.redis, redisSub: fastify.redisSub, pg: fastify.pg, log: fastify.log },
      config.notify,
    );

    fastify.addHook('onReady', async () => {
      streamer.start();
      await correlator.start();
      await notifier.start();
    });
    fastify.addHook('onClose', async () => {
      streamer.stop();
      await correlator.stop();
      await notifier.stop();
    });
  }

  return fastify;
}
