export * from './severity.js';
export * from './nagios-states.js';

/** Redis key/channel names — single source of truth across services. */
export const REDIS_KEYS = Object.freeze({
  hostState: (host) => `watcher:state:host:${host}`,
  serviceState: (host, svc) => `watcher:state:svc:${host}/${svc}`,
  stateIndex: 'watcher:state:index',              // set of all known object keys
  pollerSample: (deviceId, metric, instance) =>
    `watcher:poller:last:${deviceId}:${metric}:${instance}`,
  eventsState: 'watcher:events:state',            // pub/sub: raw state changes
  eventsAlerts: 'watcher:events:alerts',          // pub/sub: correlated alerts
  eventsMetrics: 'watcher:events:metrics',        // pub/sub: live metric ticks for open charts
  // Freshness heartbeat: streamer stamps this on every successful parse so the
  // API/UI can detect a stalled monitoring engine (silent-blindness guard).
  nagiosHeartbeat: 'watcher:nagios:heartbeat',
  // Notification de-duplication / throttle markers (per alert key).
  notifyThrottle: (tenantId, key) => `watcher:notify:throttle:${tenantId}:${key}`,
  // Login brute-force counter (per username+tenant).
  loginAttempts: (tenant, username) => `watcher:auth:attempts:${tenant}:${username}`,
});

/** Symbolic states for Watcher's own internal (platform self-monitoring) alerts. */
export const INTERNAL_DEVICE = '__watcher__';
