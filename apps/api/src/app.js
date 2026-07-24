/**
 * Application factory — builds and wires the Fastify instance.
 * Split from server.js so tests can build an app without binding a port.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';

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

import { NagiosStreamer } from './modules/nagios/streamer.js';
import { CorrelationEngine } from './modules/alerts/correlation-engine.js';

export async function buildApp(config, { withBackgroundJobs = true } = {}) {
  const fastify = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
  });

  await fastify.register(cors, { origin: config.corsOrigins, credentials: true });
  await fastify.register(dbPlugin, { pg: config.pg, tsdb: config.tsdb });
  await fastify.register(redisPlugin, { url: config.redisUrl });
  await fastify.register(authPlugin, { secret: config.jwt.secret, ttl: config.jwt.ttl });
  await fastify.register(wsHub);

  fastify.get('/healthz', async () => ({ ok: true, uptime: process.uptime() }));

  await fastify.register(authRoutes, { prefix: '/api/auth' });
  await fastify.register(nagiosRoutes, { prefix: '/api/nagios', nagios: config.nagios });
  await fastify.register(alertRoutes, { prefix: '/api/alerts' });
  await fastify.register(metricsRoutes, { prefix: '/api/metrics' });
  await fastify.register(deviceRoutes, { prefix: '/api/devices' });
  await fastify.register(dashboardRoutes, { prefix: '/api/dashboards' });
  await fastify.register(discoveryRoutes, { prefix: '/api/discovery' });

  if (withBackgroundJobs) {
    const streamer = new NagiosStreamer(
      { redis: fastify.redis, tsdb: fastify.tsdb, log: fastify.log },
      config.nagios,
    );
    const correlator = new CorrelationEngine({
      redis: fastify.redis,
      redisSub: fastify.redisSub,
      pg: fastify.pg,
      log: fastify.log,
    });

    fastify.addHook('onReady', async () => {
      streamer.start();
      await correlator.start();
    });
    fastify.addHook('onClose', async () => {
      streamer.stop();
      await correlator.stop();
    });
  }

  return fastify;
}
