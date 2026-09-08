#!/usr/bin/env node
/**
 * Ingest throughput for the 1.1 collection paths.
 *
 * What this measures, stated so the numbers are not read as more than they
 * are: the **code added in 1.1**, with the datastores replaced by doubles.
 * It answers "can the parser, the rule engine and the aggregator keep up
 * with a real device estate", which is the question the design decisions
 * were made against. It does not measure Postgres, TimescaleDB or Redis, and
 * it is not a substitute for `scripts/loadtest.mjs`, which drives the real
 * stack over HTTP.
 *
 * The reason to have it at all: every one of these paths is a UDP listener.
 * A listener that cannot keep up does not return an error to anybody — it
 * silently drops datagrams in the kernel, and the monitoring system reports
 * that everything is fine. The failure is invisible, so the headroom has to
 * be measured rather than assumed.
 *
 *   node scripts/ingest-bench.mjs
 */
import { parseSyslog } from '@watcher/shared/syslog';
import { evaluateEvent } from '@watcher/shared/events';
import { decodeFlowPacket, aggregationKey } from '@watcher/shared/flow';
import { normaliseConfig, configHash, diffConfigs } from '@watcher/shared/config-drift';
import { EventPipeline } from '../apps/poller/src/receivers/pipeline.js';
import { FlowAggregator } from '../apps/poller/src/receivers/flow.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const silent = { info() {}, warn() {}, error() {}, debug() {} };

const rate = (n, ms) => Math.round(n / (ms / 1000));
const results = [];
function record(label, n, ms, unit = '/s') {
  results.push({ label, n, ms: Math.round(ms), rate: rate(n, ms), unit });
}

async function timed(label, n, fn, unit) {
  // One untimed pass so the JIT has seen the code before it is measured.
  await fn(Math.min(n, 2000));
  const t0 = performance.now();
  await fn(n);
  record(label, n, performance.now() - t0, unit);
}

/* ── syslog ────────────────────────────────────────────────────────────── */

const SYSLOG_LINES = [
  '<27>1 2026-09-08T22:14:15.003Z sw1 bgpd 900 - - neighbor 10.0.0.1 Down (Peer closed the session)',
  '<190>Sep  8 22:14:15 sw1 %LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to down',
  '<34>Oct 11 22:14:15 fw1 sshd[1234]: Failed password for root from 10.0.0.9 port 55232 ssh2',
  '<86>1 2026-09-08T22:14:15Z host su - - [meta@1 x="1"] pam_unix(su:session): session opened',
];

await timed('syslog parse (RFC 3164 + 5424 mixed)', 200_000, (n) => {
  for (let i = 0; i < n; i++) parseSyslog(SYSLOG_LINES[i & 3]);
});

/* ── the rule engine ───────────────────────────────────────────────────── */

// A rule set the size an estate actually accumulates, with the match on the
// LAST rule so every evaluation walks the whole decision list — the worst
// case, not the happy one.
const RULES = [
  ...Array.from({ length: 39 }, (_, i) => ({
    id: `r${i}`, priority: i, source: 'trap', matchOid: `1.3.6.1.4.1.${1000 + i}`,
    action: 'alert', severity: 'warning', checkName: `vendor ${i}`,
  })),
  { id: 'last', priority: 99, source: 'syslog', maxSeverity: 3,
    matchPattern: 'neighbor (\\S+) Down', action: 'alert', severity: 'critical',
    checkName: 'bgp {1}', autoClearSeconds: 3600 },
];
const SYSLOG_EVENT = {
  source: 'syslog', oid: '', facility: 23, severity: 3, appName: 'bgpd',
  message: 'neighbor 10.0.0.1 Down (Peer closed the session)', deviceName: 'sw1',
};

await timed('rule evaluation (40 rules, match on the last)', 200_000, (n) => {
  for (let i = 0; i < n; i++) evaluateEvent(RULES, SYSLOG_EVENT);
});

/* ── the whole event pipeline ──────────────────────────────────────────── */

const pgDouble = {
  async query(sql) {
    if (/FROM tenants/.test(sql)) return { rows: [{ id: TENANT }] };
    if (/FROM devices WHERE address/.test(sql)) {
      return { rows: [{ id: 'd1', tenant_id: TENANT, name: 'sw1', address: '10.0.0.1' }] };
    }
    if (/FROM event_sources/.test(sql)) return { rows: [] };
    if (/FROM event_rules/.test(sql)) {
      return { rows: [{ id: 'r1', tenant_id: TENANT, name: 'Syslog error', source: 'syslog',
        enabled: true, priority: 50, match_oid: '', match_pattern: '', match_app: '',
        match_facility: null, max_severity: 3, action: 'alert', severity: 'critical',
        check_name: 'syslog {app}', auto_clear_seconds: 3600 }] };
    }
    return { rows: [] };
  },
};
const noopStore = { async query() { return { rows: [] }; } };
const noopBus = { async publish() {} };

const pipeline = new EventPipeline({
  pg: pgDouble, tsdb: noopStore, redis: noopBus, log: silent,
  limits: { limit: 10_000_000, windowMs: 60_000 },
});

await timed('event pipeline end to end (identify → store → decide → publish)', 100_000, async (n) => {
  for (let i = 0; i < n; i++) {
    await pipeline.handle({
      source: 'syslog', sourceIp: '10.0.0.1', timestamp: new Date(),
      oid: '', facility: 23, severity: 3, facilityName: 'local7', severityName: 'err',
      appName: 'bgpd', message: `neighbor 10.0.0.${i & 255} Down`, detail: {},
    });
  }
});
await pipeline.stop();

/* ── flow ──────────────────────────────────────────────────────────────── */

function netflowV5(count) {
  const buf = Buffer.alloc(24 + count * 48);
  buf.writeUInt16BE(5, 0);
  buf.writeUInt16BE(count, 2);
  for (let i = 0; i < count; i++) {
    const at = 24 + i * 48;
    buf.writeUInt32BE(0x0a000000 + i, at);
    buf.writeUInt32BE(0x0a010000 + (i & 255), at + 4);
    buf.writeUInt16BE(1, at + 12);
    buf.writeUInt16BE(2, at + 14);
    buf.writeUInt32BE(100 + i, at + 16);
    buf.writeUInt32BE(150_000 + i, at + 20);
    buf.writeUInt16BE(40000 + (i & 1023), at + 32);
    buf.writeUInt16BE(443, at + 34);
    buf.writeUInt8(6, at + 38);
  }
  return buf;
}

// 30 records is a typical NetFlow v5 datagram.
const FLOW_PACKET = netflowV5(30);
const templates = new Map();

await timed('NetFlow v5 decode', 300_000, (n) => {
  for (let i = 0; i < n / 30; i++) decodeFlowPacket(FLOW_PACKET, templates, '10.0.0.1');
}, ' records/s');

const { records: FLOW_RECORDS } = decodeFlowPacket(FLOW_PACKET, templates, '10.0.0.1');
await timed('flow aggregation key', 500_000, (n) => {
  for (let i = 0; i < n; i++) aggregationKey(FLOW_RECORDS[i % FLOW_RECORDS.length]);
});

/* ── config normalisation ──────────────────────────────────────────────── */

const CONFIG = [
  'Building configuration...',
  'Current configuration : 8213 bytes',
  '! Last configuration change at 09:14:02 UTC Mon Sep 7 2026 by admin',
  'hostname sw1',
  'enable secret 5 $1$abcd$eFgHiJkLmNoPqRsTu0',
  'snmp-server community S3cr3tC0mmunity RO',
  'ntp clock-period 17179856',
  ...Array.from({ length: 400 }, (_, i) =>
    `interface GigabitEthernet0/${i}\n description link ${i}\n switchport access vlan ${i % 100}`),
].join('\n');

await timed('config normalise + hash (1200-line config)', 2_000, (n) => {
  for (let i = 0; i < n; i++) configHash(normaliseConfig(CONFIG, 'cisco-ios', [], 'k'));
});

const A = normaliseConfig(CONFIG, 'cisco-ios');
const B = normaliseConfig(CONFIG.replace('description link 200', 'description CHANGED'), 'cisco-ios');
await timed('config diff (1200 lines, one changed)', 500, (n) => {
  for (let i = 0; i < n; i++) diffConfigs(A, B);
});

/* ── the reduction that makes flow storable ────────────────────────────── */

const agg = new FlowAggregator({ maxKeys: 20_000 });
const big = netflowV5(30);
for (let p = 0; p < 2000; p++) {
  const { records } = decodeFlowPacket(big, templates, '10.0.0.1');
  for (const r of records) agg.add(r, '10.0.0.1', 'd1', TENANT);
}
const reduction = { records: 60_000, rows: agg.size };

/* ── report ────────────────────────────────────────────────────────────── */

const w = Math.max(...results.map((r) => r.label.length));
console.log('\nWatcher 1.1 ingest throughput');
console.log('measured against datastore doubles — this is the added code, not the databases\n');
for (const r of results) {
  console.log(`  ${r.label.padEnd(w)}  ${String(r.rate).padStart(9)}${r.unit}`
    + `   (${r.n.toLocaleString()} in ${r.ms}ms)`);
}
console.log(`\n  flow aggregation reduction${' '.repeat(Math.max(0, w - 26))}  `
  + `${reduction.records.toLocaleString()} records → ${reduction.rows.toLocaleString()} rows `
  + `(${Math.round(reduction.records / reduction.rows)}×)`);
console.log(`\n  node ${process.version}\n`);
