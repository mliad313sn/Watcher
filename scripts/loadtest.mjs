/** R3 load harness: p50/p95/p99 per hot endpoint at 20 concurrent workers. */
const B = 'http://127.0.0.1:8080';
const login = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) })).json();
const H = { Authorization: `Bearer ${login.token}` };

const ENDPOINTS = [
  ['/api/nagios/state', 'live state (Redis fan-in)'],
  ['/api/nagios/summary', 'summary tiles'],
  ['/api/alerts', 'correlation center list'],
  ['/api/nagios/events/recent?limit=60', 'feed backfill'],
  ['/api/metrics/sla?days=7', 'fleet SLA (heaviest read)'],
  ['/api/devices/topology/graph', 'topology graph'],
  ['/', 'console page (static)'],
];

const CONCURRENCY = 20, DURATION_MS = 8000;
const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
const results = [];

for (const [path, label] of ENDPOINTS) {
  const lat = [];
  let errors = 0;
  const stopAt = Date.now() + DURATION_MS;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (Date.now() < stopAt) {
      const t0 = performance.now();
      try {
        const r = await fetch(B + path, { headers: H });
        await r.arrayBuffer();
        if (r.status >= 500) errors++;
        else lat.push(performance.now() - t0);
      } catch { errors++; }
    }
  }));
  lat.sort((a, b) => a - b);
  const row = {
    path, label, requests: lat.length, errors,
    rps: Math.round(lat.length / (DURATION_MS / 1000)),
    p50: pct(lat, 0.50).toFixed(1), p95: pct(lat, 0.95).toFixed(1), p99: pct(lat, 0.99).toFixed(1),
  };
  results.push(row);
  console.log(`${path.padEnd(40)} ${String(row.rps).padStart(5)} req/s  p50=${row.p50}ms p95=${row.p95}ms p99=${row.p99}ms err=${errors}`);
}

const worstP95 = Math.max(...results.map((r) => Number(r.p95)));
const totalErr = results.reduce((a, r) => a + r.errors, 0);
console.log(`\nworst p95: ${worstP95}ms · errors: ${totalErr}`);
console.log(JSON.stringify(results));
process.exit(totalErr > 0 || worstP95 > 500 ? 1 : 0);
