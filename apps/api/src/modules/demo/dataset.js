/**
 * Demo dataset — a realistic enterprise fleet used by the 60-second demo /
 * guided first-run so a fresh install shows a living operations centre instead
 * of an empty screen (the committee's #1 time-to-value unlock).
 *
 * This module is pure data + deterministic generators: no I/O. The seed engine
 * (seed.js) turns it into rows across Postgres, TimescaleDB and Redis.
 */

// Host states: 0 UP, 1 DOWN, 2 UNREACHABLE. Service states: 0 OK, 1 WARN, 2 CRIT.
export const FLEET = [
  { name: 'core-sw-01', kind: 'switch', vendor: 'Cisco', model: 'C9500', addr: '10.0.0.1', loc: 'HQ · Core', parent: null, state: 0 },
  { name: 'core-sw-02', kind: 'switch', vendor: 'Cisco', model: 'C9500', addr: '10.0.0.2', loc: 'HQ · Core', parent: null, state: 0 },
  { name: 'edge-fw-01', kind: 'firewall', vendor: 'Palo Alto', model: 'PA-3220', addr: '10.0.0.254', loc: 'HQ · Edge', parent: 'core-sw-01', state: 0 },
  { name: 'dist-sw-nyc-01', kind: 'switch', vendor: 'Cisco', model: 'C9300', addr: '10.1.0.1', loc: 'NYC · Distribution', parent: 'core-sw-01', state: 0 },
  { name: 'dist-sw-sfo-01', kind: 'switch', vendor: 'Cisco', model: 'C9300', addr: '10.2.0.1', loc: 'SFO · Distribution', parent: 'core-sw-02', state: 1 }, // DOWN — a root cause
  { name: 'app-srv-01', kind: 'server', vendor: 'Dell', model: 'R750', addr: '10.1.1.11', loc: 'NYC · Rack A', parent: 'dist-sw-nyc-01', state: 0 },
  { name: 'app-srv-02', kind: 'server', vendor: 'Dell', model: 'R750', addr: '10.1.1.12', loc: 'NYC · Rack A', parent: 'dist-sw-nyc-01', state: 0 },
  { name: 'app-srv-sfo-03', kind: 'server', vendor: 'Dell', model: 'R650', addr: '10.2.1.13', loc: 'SFO · Rack C', parent: 'dist-sw-sfo-01', state: 2 }, // UNREACHABLE behind the down switch
  { name: 'db-cluster-01', kind: 'server', vendor: 'Dell', model: 'R760', addr: '10.1.1.21', loc: 'NYC · Rack B', parent: 'core-sw-01', state: 0 },
  { name: 'san-01', kind: 'storage', vendor: 'NetApp', model: 'AFF-A250', addr: '10.1.1.30', loc: 'NYC · Rack B', parent: 'core-sw-02', state: 0 },
  { name: 'wap-hq-01', kind: 'wireless_ap', vendor: 'Cisco Meraki', model: 'MR46', addr: '10.1.9.11', loc: 'HQ · Floor 3', parent: 'dist-sw-nyc-01', state: 0 },
  { name: 'wap-hq-02', kind: 'wireless_ap', vendor: 'Cisco Meraki', model: 'MR46', addr: '10.1.9.12', loc: 'HQ · Floor 4', parent: 'dist-sw-nyc-01', state: 0 },
  { name: 'pbx-01', kind: 'pbx', vendor: 'Sangoma', model: 'FreePBX', addr: '10.1.1.40', loc: 'NYC · Voice', parent: 'core-sw-02', state: 0 },
];

/**
 * Services per host. `state`: 0 OK / 1 WARN / 2 CRIT. `flag`: optional
 * ack | flapping, to demonstrate the alert console's states.
 */
export const SERVICES = [
  { host: 'app-srv-01', service: 'HTTP', state: 0, output: 'HTTP OK: 200 in 0.041s' },
  { host: 'app-srv-01', service: 'SSH', state: 0, output: 'SSH OK - OpenSSH_9.6' },
  { host: 'app-srv-01', service: 'CPU Load', state: 0, output: 'OK - load 1.8 across 8 cores' },
  { host: 'app-srv-02', service: 'HTTP', state: 0, output: 'HTTP OK: 200 in 0.055s' },
  { host: 'app-srv-02', service: 'SSH', state: 0, output: 'SSH OK - OpenSSH_9.6' },
  { host: 'db-cluster-01', service: 'PostgreSQL', state: 2, output: 'CRITICAL - CPU load 97% sustained 6m' },
  { host: 'db-cluster-01', service: 'Replication Lag', state: 1, output: 'WARNING - replica lag 312s > 300s' },
  { host: 'db-cluster-01', service: 'SSH', state: 0, output: 'SSH OK - OpenSSH_9.6' },
  { host: 'san-01', service: 'Volume Space', state: 1, output: 'WARNING - volume "prod" 8% free', flag: 'ack' },
  { host: 'dist-sw-nyc-01', service: 'Interface Gi1/0/24', state: 0, output: 'OK - link up 10Gbps' },
  { host: 'dist-sw-nyc-01', service: 'BGP Session', state: 1, output: 'WARNING - BGP flapped 3× in 10m (peer 10.0.4.254)', flag: 'flapping' },
  { host: 'app-srv-sfo-03', service: 'HTTP', state: 2, output: 'CRITICAL - connection timed out' }, // suppressed under sfo switch
  { host: 'pbx-01', service: 'SIP Trunk', state: 0, output: 'OK - 4 trunks registered' },
  { host: 'pbx-01', service: 'Queue Depth', state: 0, output: 'OK - 0 calls waiting' },
  { host: 'wap-hq-01', service: 'Client Count', state: 0, output: 'OK - 38 associated clients' },
];

/** Which metric series each device should carry, for gauges + charts. */
export const METRICS = {
  server: ['cpu.util.pct', 'mem.used.pct', 'disk.used.pct'],
  switch: ['cpu.util.pct'],
  firewall: ['cpu.util.pct', 'mem.used.pct'],
  storage: ['disk.used.pct'],
  wireless_ap: ['wifi.clients'],
  pbx: ['pbx.calls.active', 'pbx.channels.active'],
};

/** Interfaces that carry traffic series (for the device traffic chart). */
export const INTERFACES = {
  'core-sw-01': ['Gi1/0/1', 'Gi1/0/2', 'Te1/1/1'],
  'core-sw-02': ['Gi1/0/1', 'Te1/1/1'],
  'dist-sw-nyc-01': ['Gi1/0/24', 'Gi1/0/48'],
  'edge-fw-01': ['ethernet1/1', 'ethernet1/2'],
};

/** Small deterministic PRNG (mulberry32) so demo data is stable across runs. */
export function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A realistic time series over the trailing `hours` at `stepMin` resolution.
 * Combines a daily-ish sine with seeded noise; optionally trends toward `end`.
 * @returns {{time: Date, value: number}[]}
 */
export function series({ seed, hours = 6, stepMin = 5, base = 40, amp = 15, end = null, min = 0, max = 100, nowMs = Date.now() }) {
  const rand = rng(seed);
  const points = Math.floor((hours * 60) / stepMin);
  const out = [];
  for (let i = points; i >= 0; i--) {
    const t = nowMs - i * stepMin * 60_000;
    const phase = (t / (3600_000 * 4)) * Math.PI; // ~8h cycle
    let v = base + Math.sin(phase) * amp + (rand() - 0.5) * amp * 0.8;
    if (end != null) {
      const progress = 1 - i / points;            // 0→1 across the window
      v = v * (1 - progress) + end * progress + (rand() - 0.5) * 4;
    }
    out.push({ time: new Date(t), value: Math.max(min, Math.min(max, Number(v.toFixed(2)))) });
  }
  return out;
}

/** Config for each metric's shape so the demo reads believably. */
export function metricShape(deviceName, metric) {
  const seed = hash(`${deviceName}:${metric}`);
  switch (metric) {
    case 'cpu.util.pct':
      // db-cluster-01 climbs to a critical 97% to match its alert.
      return deviceName === 'db-cluster-01'
        ? { seed, base: 55, amp: 12, end: 97 }
        : { seed, base: 28, amp: 16 };
    case 'mem.used.pct': return { seed, base: 62, amp: 10 };
    case 'disk.used.pct':
      return deviceName === 'san-01'
        ? { seed, base: 88, amp: 3, end: 92 }   // matches the "8% free" warning
        : { seed, base: 47, amp: 6 };
    case 'wifi.clients': return { seed, base: 34, amp: 12, max: 200 };
    case 'pbx.calls.active': return { seed, base: 12, amp: 8, max: 200 };
    case 'pbx.channels.active': return { seed, base: 18, amp: 10, max: 400 };
    default: return { seed, base: 40, amp: 15 };
  }
}

/** Interface traffic in bps — asymmetric in/out, uplinks busier. */
export function trafficShape(deviceName, ifName, dir) {
  const seed = hash(`${deviceName}:${ifName}:${dir}`);
  const uplink = /Te|1\/1|48/.test(ifName);
  const base = uplink ? 3.2e9 : 4.0e8;
  const amp = uplink ? 1.6e9 : 2.2e8;
  return { seed, base: dir === 'in' ? base : base * 0.7, amp, min: 0, max: 1e11 };
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const DEMO_TAG = 'watcher:demo'; // marks demo-created rows for clean teardown
