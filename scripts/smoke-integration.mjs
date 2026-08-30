/**
 * Integration smoke test — proves the product runs as a whole system.
 *
 * Boots the real API (with the Nagios streamer, correlation engine and
 * notifier running), drives an actual status.dat through the live pipeline,
 * and asserts the full chain works end to end:
 *
 *   status.dat  →  streamer  →  Redis state  →  /nagios/state
 *                                    │
 *                                    └→ correlation → alerts → /alerts
 *
 * It then exercises the entire REST surface to confirm nothing 500s from a
 * schema or wiring mismatch.
 *
 * Requires: a reachable Postgres (config plane), a metrics DB, and Redis —
 * configured via the usual env vars. Run from apps/api so workspace deps
 * resolve:  node ../../scripts/smoke-integration.mjs
 */
import { writeFileSync } from 'node:fs';
import pg from 'pg';

const STATUS_FILE = process.env.NAGIOS_STATUS_FILE || '/tmp/status.dat';
process.env.NAGIOS_STATUS_FILE = STATUS_FILE;
process.env.NAGIOS_POLL_INTERVAL = process.env.NAGIOS_POLL_INTERVAL || '400';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

const { buildApp } = await import('../apps/api/src/app.js');
const { config } = await import('../apps/api/src/config.js');

const pool = new pg.Pool(config.pg);
let fails = 0;
const assert = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}`); if (!cond) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Inventory the pipeline needs (host_name == device name; topology for deps)
const T = (await pool.query('SELECT id FROM tenants ORDER BY created_at LIMIT 1')).rows[0].id;
await pool.query("DELETE FROM alerts WHERE device_name LIKE 'smoke-%'");
await pool.query("DELETE FROM devices WHERE name LIKE 'smoke-%'");
const core = (await pool.query(
  "INSERT INTO devices (tenant_id,name,kind) VALUES ($1,'smoke-core','switch') RETURNING id", [T])).rows[0].id;
await pool.query(
  "INSERT INTO devices (tenant_id,name,kind,parent_id) VALUES ($1,'smoke-app',$2,$3)",
  [T, 'server', core]);

// ── A valid status.dat builder ────────────────────────────────────────────
function statusDat(objs) {
  const now = Math.floor(Date.now() / 1000);
  let out = `########################################\n# NAGIOS STATUS FILE\n########################################\n`;
  out += `programstatus {\n\tnagios_pid=1\n\tlast_command_check=${now}\n\t}\n`;
  for (const o of objs) {
    if (o.service) {
      out += `servicestatus {\n\thost_name=${o.host}\n\tservice_description=${o.service}\n`
        + `\tcurrent_state=${o.state}\n\tstate_type=1\n\tplugin_output=${o.output}\n`
        + `\tlast_check=${now}\n\tlast_state_change=${now}\n\tis_flapping=0\n`
        + `\tproblem_has_been_acknowledged=0\n\tscheduled_downtime_depth=0\n\tcurrent_attempt=1\n\tmax_attempts=3\n\t}\n`;
    } else {
      out += `hoststatus {\n\thost_name=${o.host}\n\tcurrent_state=${o.state}\n\tstate_type=1\n`
        + `\tplugin_output=${o.output}\n\tlast_check=${now}\n\tlast_state_change=${now}\n\tis_flapping=0\n`
        + `\tproblem_has_been_acknowledged=0\n\tscheduled_downtime_depth=0\n\tcurrent_attempt=1\n\tmax_attempts=3\n\t}\n`;
    }
  }
  return out;
}

// Start all-healthy so the first parse establishes a baseline.
writeFileSync(STATUS_FILE, statusDat([
  { host: 'smoke-core', state: 0, output: 'PING OK' },
  { host: 'smoke-app', state: 0, output: 'PING OK' },
  { host: 'smoke-app', service: 'HTTP', state: 0, output: 'HTTP OK: 200' },
]));

const app = await buildApp(config, { withBackgroundJobs: true });
await app.listen({ host: '127.0.0.1', port: 8091 });
const login = await (await fetch('http://127.0.0.1:8091/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin' }) })).json();
const H = { Authorization: 'Bearer ' + login.token };
const B = 'http://127.0.0.1:8091';
const getJ = async (p) => (await fetch(B + p, { headers: H })).json();

// Give the streamer a couple of ticks to ingest the baseline.
await sleep(1200);
let state = await getJ('/api/nagios/state');
assert(state.hosts.some((h) => h.host === 'smoke-core') && state.services.some((s) => s.service === 'HTTP'),
  'streamer ingested status.dat → live state served by /api/nagios/state');

// ── Inject an outage: core switch DOWN, app UNREACHABLE, its HTTP CRITICAL ──
writeFileSync(STATUS_FILE, statusDat([
  { host: 'smoke-core', state: 1, output: 'CRITICAL - host down' },
  { host: 'smoke-app', state: 2, output: 'UNREACHABLE - via smoke-core' },
  { host: 'smoke-app', service: 'HTTP', state: 2, output: 'CRITICAL - timeout' },
]));
// streamer diff → publish → correlation. Wide enough to cover retro-suppression:
// when a child alert is processed before its root cause, the engine re-suppresses
// it on the next event, which is a second async hop.
await sleep(2400);

state = await getJ('/api/nagios/state');
const coreState = state.hosts.find((h) => h.host === 'smoke-core');
assert(coreState && coreState.state === 1, 'state change flowed live: smoke-core now DOWN');

const summary = await getJ('/api/nagios/summary');
assert(summary.hosts.down >= 1, 'summary reflects the outage');

const { alerts } = await getJ('/api/alerts');
const rootCause = alerts.find((a) => a.device_name === 'smoke-core' && a.check_name === '');
assert(rootCause && rootCause.severity === 'critical' && rootCause.status === 'open',
  'correlation engine opened the root-cause host alert');
const child = alerts.find((a) => a.device_name === 'smoke-app' && a.check_name === 'HTTP');
assert(child && child.status === 'suppressed' && child.suppressed_by,
  'child alert suppressed under the root cause (live dependency correlation)');

// ── Recover: everything back OK → alerts resolve ───────────────────────────
writeFileSync(STATUS_FILE, statusDat([
  { host: 'smoke-core', state: 0, output: 'PING OK' },
  { host: 'smoke-app', state: 0, output: 'PING OK' },
  { host: 'smoke-app', service: 'HTTP', state: 0, output: 'HTTP OK: 200' },
]));
await sleep(1400);
const active = (await getJ('/api/alerts?status=open')).alerts.filter((a) => a.device_name.startsWith('smoke-'));
assert(active.length === 0, 'recovery resolved the alerts live');

// ── /readyz reflects real dependency health ────────────────────────────────
const ready = await (await fetch(B + '/readyz')).json();
assert(ready.checks.postgres === 'ok' && ready.checks.redis === 'ok' && ready.checks.nagios === 'ok',
  `/readyz: postgres+redis+nagios healthy (${JSON.stringify(ready.checks)})`);

// ── Full REST surface: nothing 500s ────────────────────────────────────────
const endpoints = [
  '/api/auth/me', '/api/devices', '/api/devices/topology/graph', '/api/nagios/state',
  '/api/nagios/summary', '/api/alerts', '/api/alerts/summary', '/api/alerts/rules',
  '/api/dashboards', '/api/discovery/jobs', '/api/oncall/schedules', '/api/runbooks',
  '/api/status/components', '/api/demo/status',
];
let worst = 0;
for (const e of endpoints) {
  const r = await fetch(B + e, { headers: H });
  worst = Math.max(worst, r.status);
  if (r.status >= 500) console.log(`   500 on ${e}`);
}
assert(worst < 500, `all ${endpoints.length} core endpoints respond without a 500 (worst ${worst})`);

// ── Public status page works unauthenticated ───────────────────────────────
const pub = await (await fetch(B + '/api/status/public?tenant=default')).json();
assert(Array.isArray(pub.components), 'public status endpoint works without auth');

await app.close();
await pool.end();
console.log(fails === 0 ? '\nINTEGRATION SMOKE: ALL PASS' : `\nINTEGRATION SMOKE: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
