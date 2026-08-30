/** Central environment configuration for the API. */

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export const config = {
  host: env('API_HOST', '0.0.0.0'),
  port: Number(env('API_PORT', 8080)),
  logLevel: env('LOG_LEVEL', 'info'),
  corsOrigins: env('CORS_ORIGINS', 'http://localhost:5173').split(','),
  // Where the web UI is reachable — used to build one-tap mobile ack links
  // in notifications.
  publicBaseUrl: env('PUBLIC_BASE_URL', 'http://localhost:5173'),
  // When set, the API also serves the built web UI from this directory,
  // making the whole product reachable as a single origin (no separate web
  // server or dev proxy needed). Empty in dev, where Vite serves the UI.
  webDist: env('WEB_DIST', ''),

  jwt: {
    secret: env('JWT_SECRET', 'dev-only-secret'),
    ttl: env('JWT_TTL', '8h'),
  },

  pg: {
    host: env('PG_HOST', 'localhost'),
    port: Number(env('PG_PORT', 5432)),
    database: env('PG_DATABASE', 'watcher'),
    user: env('PG_USER', 'watcher'),
    password: env('PG_PASSWORD', 'watcher'),
    max: Number(env('PG_POOL_MAX', 10)),
  },

  tsdb: {
    host: env('TSDB_HOST', 'localhost'),
    port: Number(env('TSDB_PORT', 5433)),
    database: env('TSDB_DATABASE', 'watcher_metrics'),
    user: env('TSDB_USER', 'watcher'),
    password: env('TSDB_PASSWORD', 'watcher'),
    max: Number(env('TSDB_POOL_MAX', 10)),
  },

  redisUrl: env('REDIS_URL', 'redis://localhost:6379'),

  nagios: {
    statusFile: env('NAGIOS_STATUS_FILE', '/usr/local/nagios/var/status.dat'),
    commandFile: env('NAGIOS_COMMAND_FILE', '/usr/local/nagios/var/rw/nagios.cmd'),
    pollInterval: Number(env('NAGIOS_POLL_INTERVAL', 5000)),
    livestatusSocket: env('NAGIOS_LIVESTATUS_SOCKET', ''),
    // Objects are considered stale (monitoring blind) if status.dat hasn't been
    // rewritten within this window. Default: max(30s, 4× poll interval).
    staleThresholdMs: process.env.NAGIOS_STALE_THRESHOLD_MS
      ? Number(process.env.NAGIOS_STALE_THRESHOLD_MS) : undefined,
  },

  notify: {
    // One page per incident per cooldown (seconds); escalations bypass it.
    cooldownS: Number(env('NOTIFY_COOLDOWN_S', 300)),
    // Optional catch-all webhook so a fresh install pages somewhere even
    // before any alert_rules are configured.
    fallbackWebhook: env('NOTIFY_FALLBACK_WEBHOOK', ''),
    // How often to sweep for unacknowledged criticals to escalate (ms).
    sweepMs: Number(env('NOTIFY_SWEEP_MS', 30000)),
  },
};
