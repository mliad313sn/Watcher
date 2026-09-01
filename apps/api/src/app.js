/**
 * Application factory — builds and wires the Fastify instance.
 * Split from server.js so tests can build an app without binding a port.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
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
import runbookRoutes from './modules/runbooks/routes.js';
import statusRoutes from './modules/status/routes.js';
import maintenanceRoutes from './modules/maintenance/routes.js';
import configRoutes from './modules/config/routes.js';
import ingestRoutes from './modules/ingest/routes.js';

import { NagiosStreamer } from './modules/nagios/streamer.js';
import { CorrelationEngine } from './modules/alerts/correlation-engine.js';
import { NotifierEngine } from './modules/alerts/notifier.js';
import { AnomalyEngine } from './modules/anomaly/engine.js';

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

  // Prometheus exposition for Watcher itself — scrape-ready like any exporter,
  // so Watcher is a good citizen inside Prometheus/Grafana estates.
  fastify.get('/metrics', async (request, reply) => {
    const mem = process.memoryUsage();
    const lines = [
      '# HELP watcher_up 1 when the Watcher API process is serving.',
      '# TYPE watcher_up gauge',
      'watcher_up 1',
      '# HELP watcher_uptime_seconds API process uptime.',
      '# TYPE watcher_uptime_seconds counter',
      `watcher_uptime_seconds ${process.uptime().toFixed(0)}`,
      '# HELP watcher_process_resident_memory_bytes RSS of the API process.',
      '# TYPE watcher_process_resident_memory_bytes gauge',
      `watcher_process_resident_memory_bytes ${mem.rss}`,
    ];
    try {
      const { rows } = await fastify.pg.query(
        `SELECT severity, status, count(*)::int AS n FROM alerts
         WHERE status <> 'resolved' GROUP BY severity, status`);
      lines.push('# HELP watcher_alerts Active alerts by severity and status.',
        '# TYPE watcher_alerts gauge');
      for (const r of rows) lines.push(`watcher_alerts{severity="${r.severity}",status="${r.status}"} ${r.n}`);
      const dev = await fastify.pg.query('SELECT count(*)::int AS n FROM devices WHERE monitored');
      lines.push('# HELP watcher_devices_monitored Devices under monitoring.',
        '# TYPE watcher_devices_monitored gauge',
        `watcher_devices_monitored ${dev.rows[0].n}`);
    } catch { /* DB briefly away — process metrics still expose */ }
    return reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(lines.join('\n') + '\n');
  });

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

  await fastify.register(authRoutes, {
    prefix: '/api/auth', sso: config.sso, publicBaseUrl: config.publicBaseUrl,
  });
  await fastify.register(nagiosRoutes, { prefix: '/api/nagios', nagios: config.nagios });
  await fastify.register(alertRoutes, { prefix: '/api/alerts' });
  await fastify.register(metricsRoutes, { prefix: '/api/metrics' });
  await fastify.register(deviceRoutes, { prefix: '/api/devices' });
  await fastify.register(dashboardRoutes, { prefix: '/api/dashboards' });
  await fastify.register(discoveryRoutes, { prefix: '/api/discovery' });
  await fastify.register(demoRoutes, { prefix: '/api/demo' });
  await fastify.register(oncallRoutes, { prefix: '/api/oncall' });
  await fastify.register(runbookRoutes, { prefix: '/api/runbooks' });
  await fastify.register(statusRoutes, { prefix: '/api/status' });
  await fastify.register(maintenanceRoutes, { prefix: '/api/maintenance' });
  await fastify.register(configRoutes, { prefix: '/api/config' });
  await fastify.register(ingestRoutes, { prefix: '/api/ingest' });

  // Optionally serve the built web UI from the same origin as the API, so the
  // whole product is reachable as a single service (no dev proxy). API and
  // /ws routes are already registered, so they take precedence; anything else
  // is resolved against the static bundle. A bare directory request ("/") and
  // any unmatched path fall back to the SPA-less index page.
  if (config.webDist && existsSync(config.webDist)) {
    await fastify.register(fastifyStatic, {
      root: config.webDist,
      prefix: '/',
      wildcard: false, // let the notFound handler own unmatched paths
    });
    fastify.setNotFoundHandler((request, reply) => {
      // Never mask a missing API/WS route with an HTML page — that hides bugs
      // and breaks clients expecting JSON.
      if (request.raw.url.startsWith('/api/') || request.raw.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'not found' });
      }
      const clean = request.raw.url.split('?')[0].replace(/^\/+/, '');
      // Files that exist on disk but were built AFTER boot (an upgrade's new
      // hashed assets) have no static route yet — serve them directly so a
      // web rebuild never requires an API restart. Reject traversal first.
      if (clean && !clean.includes('..') && existsSync(join(config.webDist, clean))) {
        return reply.sendFile(clean);
      }
      // A fingerprinted asset that truly doesn't exist is a hard 404 — an
      // HTML fallback here masks build/cache bugs as MIME errors.
      if (clean.startsWith('assets/')) {
        return reply.code(404).send({ error: 'asset not found' });
      }
      // A clean path like "/devices" maps to its built "devices.html".
      const asHtml = clean === '' ? 'index.html' : `${clean}.html`;
      if (existsSync(join(config.webDist, asHtml))) return reply.sendFile(asHtml);
      return reply.sendFile('index.html');
    });
  }

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
      {
        ...config.notify,
        ackBaseUrl: config.publicBaseUrl,
        // Per-alert, single-purpose capability token for one-tap mobile ack.
        signAckToken: (alertId, tenantId) =>
          fastify.jwt.sign({ purpose: 'ack', alertId, tenantId }, { expiresIn: '24h' }),
      },
    );

    // Expose the notifier so routes can offer "send a test notification".
    fastify.decorate('notifier', notifier);

    const anomaly = config.anomaly?.enabled
      ? new AnomalyEngine(
          { pg: fastify.pg, tsdb: fastify.tsdb, redis: fastify.redis, log: fastify.log },
          config.anomaly)
      : null;

    fastify.addHook('onReady', async () => {
      streamer.start();
      await correlator.start();
      await notifier.start();
      anomaly?.start();
    });
    fastify.addHook('onClose', async () => {
      streamer.stop();
      await correlator.stop();
      await notifier.stop();
      anomaly?.stop();
    });
  }

  return fastify;
}
