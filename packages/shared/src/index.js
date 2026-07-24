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
});
