/**
 * Poller worker entrypoint: wires connectors to the scheduler and the
 * TimescaleDB metric writer, and services discovery jobs queued by the API.
 */
import pg from 'pg';
import Redis from 'ioredis';
import pino from 'pino';

import { MetricWriter } from './metric-writer.js';
import { RateCalculator } from './rate.js';
import { Scheduler } from './scheduler.js';
import { decryptCredential } from './credentials.js';
import { SnmpConnector } from './connectors/snmp.js';
import { MerakiConnector } from './connectors/meraki.js';
import { WinrmConnector } from './connectors/winrm.js';
import { AsteriskConnector } from './connectors/asterisk.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const pgPool = new pg.Pool({
  host: process.env.PG_HOST ?? 'localhost',
  port: Number(process.env.PG_PORT ?? 5432),
  database: process.env.PG_DATABASE ?? 'watcher',
  user: process.env.PG_USER ?? 'watcher',
  password: process.env.PG_PASSWORD ?? 'watcher',
});
const tsdbPool = new pg.Pool({
  host: process.env.TSDB_HOST ?? 'localhost',
  port: Number(process.env.TSDB_PORT ?? 5433),
  database: process.env.TSDB_DATABASE ?? 'watcher_metrics',
  user: process.env.TSDB_USER ?? 'watcher',
  password: process.env.TSDB_PASSWORD ?? 'watcher',
});
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

const writer = new MetricWriter({ tsdb: tsdbPool, redis, log });
const rates = new RateCalculator(redis);

const connectors = new Map();
connectors.set('snmp', new SnmpConnector({ writer, rates, log }));
connectors.set('winrm', new WinrmConnector({ writer, log }));
connectors.set('asterisk', new AsteriskConnector({ writer, log }));

// Meraki is org-scoped rather than per-device: one connector instance polls
// the whole organization on a fixed cadence when an API key is configured.
if (process.env.MERAKI_API_KEY && process.env.MERAKI_ORG_ID) {
  const meraki = new MerakiConnector({
    apiKey: process.env.MERAKI_API_KEY,
    baseUrl: process.env.MERAKI_BASE_URL ?? 'https://api.meraki.com/api/v1',
    orgId: process.env.MERAKI_ORG_ID,
  }, { writer, pg: pgPool, log });

  const tenantRow = await pgPool.query('SELECT id FROM tenants ORDER BY created_at LIMIT 1');
  const tenantId = tenantRow.rows[0]?.id;
  if (tenantId) {
    await meraki.syncInventory(tenantId).catch((err) => log.warn({ err }, 'meraki sync failed'));
    setInterval(() => {
      meraki.pollAvailability().catch((err) => log.warn({ err }, 'meraki availability failed'));
      meraki.pollWireless().catch((err) => log.warn({ err }, 'meraki wireless failed'));
    }, 60_000).unref();
  }
}

async function getCredential(id) {
  const { rows } = await pgPool.query('SELECT data_enc FROM credentials WHERE id = $1', [id]);
  if (!rows[0]) throw new Error(`credential ${id} not found`);
  return decryptCredential(rows[0].data_enc);
}

const scheduler = new Scheduler({
  pg: pgPool,
  log,
  connectors,
  getCredential,
  concurrency: Number(process.env.POLLER_CONCURRENCY ?? 32),
});
await scheduler.start();
log.info('poller started');

// LLDP auto-topology: refresh the L2 link map from what the switches
// themselves report — shortly after boot, then hourly.
import('./lldp.js').then(({ discoverLldpTopology }) => {
  const walk = async (device) => {
    const cred = decryptCredential(device.data_enc);
    return connectors.get('snmp').walkLldp(device.address, cred);
  };
  const sweep = () => discoverLldpTopology({ pg: pgPool, log }, walk)
    .then((r) => { if (r.devices > 0) log.info(r, 'LLDP topology refreshed'); })
    .catch((err) => log.warn({ err }, 'LLDP sweep failed'));
  setTimeout(sweep, 30_000).unref();
  setInterval(sweep, Number(process.env.LLDP_INTERVAL_MS ?? 3_600_000)).unref();
});

// Proxy mode: this poller runs at a remote site and reaches nothing but the
// central API, outbound only. It owns the devices assigned to it centrally,
// buffers observations when the link fails, and heartbeats so the far end
// can raise when it goes silent. Local (non-proxy) mode is unchanged.
if (process.env.WATCHER_PROXY_URL) {
  const { ProxyAgent } = await import('./proxy/agent.js');
  const agent = new ProxyAgent({
    url: process.env.WATCHER_PROXY_URL,
    token: process.env.WATCHER_PROXY_TOKEN,
    enrol: process.env.WATCHER_PROXY_ENROL,
    version: process.env.WATCHER_VERSION ?? '1.0.0-rc.1',
    maxBuffer: process.env.WATCHER_PROXY_BUFFER,
  }, {
    log,
    // Assignments replace whatever this proxy was polling: the central
    // console is the authority on which site owns which device.
    onAssignments: (devices) => scheduler.setDevices(devices),
  });
  // Device credentials stay at the site: the assignment names one, and the
  // proxy resolves the name from its own configuration file.
  if (process.env.WATCHER_PROXY_CREDENTIALS) {
    const { readFileSync } = await import('node:fs');
    scheduler.localCredentials = JSON.parse(
      readFileSync(process.env.WATCHER_PROXY_CREDENTIALS, 'utf8'));
  }
  // The connectors write through the agent rather than to the databases —
  // a proxy holds no database credential, which is half the reason a site
  // will host one at all.
  writer.forwardTo(agent);
  await agent.start({
    flushMs: Number(process.env.WATCHER_PROXY_FLUSH_MS ?? 15_000),
  });
  process.on('exit', () => agent.stop());
}

// Configuration backup. Off unless CONFIG_BACKUP=1: reaching into every
// device with privileged credentials is not something a monitoring product
// should start doing on its own.
if (process.env.CONFIG_BACKUP === '1') {
  const { ConfigBackup } = await import('./config/backup.js');
  const backup = new ConfigBackup({ pg: pgPool, redis, log }, {
    // Secrets are redacted before storage; with a key set, the placeholder
    // carries a keyed fingerprint so a ROTATION is still visible as a change
    // without the value ever landing in the database.
    fingerprintKey: process.env.CONFIG_FINGERPRINT_KEY ?? '',
    concurrency: Number(process.env.CONFIG_CONCURRENCY ?? 4),
    timeoutMs: Number(process.env.CONFIG_TIMEOUT_MS ?? 60_000),
  });
  backup.start(Number(process.env.CONFIG_INTERVAL_MS ?? 24 * 3_600_000));
}

// Event plane: SNMP traps and syslog. Off unless a port is configured —
// see apps/poller/src/receivers/index.js for why that default is deliberate.
const receivers = await import('./receivers/index.js')
  .then(({ startReceivers }) => startReceivers({ pg: pgPool, tsdb: tsdbPool, redis, log }))
  .catch((err) => { log.error({ err }, 'event receivers failed to start'); return { stop: async () => {} }; });

// Discovery job queue (BRPOP loop) — jobs are created by the API.
import('./discovery-worker.js')
  .then(({ startDiscoveryWorker }) =>
    startDiscoveryWorker({ pg: pgPool, redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379', log, connectors }))
  .catch((err) => log.warn({ err }, 'discovery worker not started'));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    log.info({ signal }, 'poller shutting down');
    scheduler.stop();
    await receivers.stop();
    await writer.close();
    await Promise.allSettled([pgPool.end(), tsdbPool.end(), redis.quit()]);
    process.exit(0);
  });
}
