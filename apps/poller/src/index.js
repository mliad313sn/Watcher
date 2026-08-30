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

// Discovery job queue (BRPOP loop) — jobs are created by the API.
import('./discovery-worker.js')
  .then(({ startDiscoveryWorker }) =>
    startDiscoveryWorker({ pg: pgPool, redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379', log, connectors }))
  .catch((err) => log.warn({ err }, 'discovery worker not started'));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    log.info({ signal }, 'poller shutting down');
    scheduler.stop();
    await writer.close();
    await Promise.allSettled([pgPool.end(), tsdbPool.end(), redis.quit()]);
    process.exit(0);
  });
}
