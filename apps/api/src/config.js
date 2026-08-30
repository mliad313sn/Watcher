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

  sso: {
    oidc: {
      issuer: env('SSO_OIDC_ISSUER', ''),
      clientId: env('SSO_OIDC_CLIENT_ID', ''),
      clientSecret: env('SSO_OIDC_CLIENT_SECRET', ''),
      scope: env('SSO_OIDC_SCOPE', 'openid profile email'),
      groupClaim: env('SSO_OIDC_GROUP_CLAIM', 'groups'),
      // "idp-group=role,…"; '*' maps everyone authenticated. Empty + no '*'
      // means deny users with no mapped group (deny-by-default).
      roleMap: env('SSO_ROLE_MAP', '*=viewer'),
      // Display label on the login button, e.g. "Keycloak", "Okta".
      label: env('SSO_OIDC_LABEL', 'Single sign-on'),
    },
    ldap: {
      url: env('SSO_LDAP_URL', ''),                       // ldaps://dc01:636
      bindDn: env('SSO_LDAP_BIND_DN', ''),                // service account ('' = anonymous)
      bindPassword: env('SSO_LDAP_BIND_PASSWORD', ''),
      searchBase: env('SSO_LDAP_SEARCH_BASE', ''),
      userFilter: env('SSO_LDAP_USER_FILTER', '(uid={username})'),
      usernameAttr: env('SSO_LDAP_USERNAME_ATTR', 'uid'),
      roleMap: env('SSO_ROLE_MAP', '*=viewer'),
    },
  },

  anomaly: {
    // Dynamic thresholds: deterministic median+MAD baselines per device+metric.
    enabled: env('ANOMALY_ENABLED', 'true') !== 'false',
    sweepMs: Number(env('ANOMALY_SWEEP_MS', 300000)),
    zThreshold: Number(env('ANOMALY_Z_THRESHOLD', 4)),
    minDeltaPct: Number(env('ANOMALY_MIN_DELTA_PCT', 10)),
    historyDays: Number(env('ANOMALY_HISTORY_DAYS', 7)),
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
