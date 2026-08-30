import '@watcher/ui';
import { startTour, tourSeen } from '@watcher/ui';
import { api, requireAuth, liveEvents, chipClassFor } from '../lib/api.js';

requireAuth();

const shell = document.querySelector('w-shell');
const feed = document.getElementById('feed');
const problems = document.getElementById('problems');
const heatmap = document.getElementById('heatmap');
const live = document.getElementById('live');
const firstrun = document.getElementById('firstrun');
const demobanner = document.getElementById('demobanner');
const user = JSON.parse(localStorage.getItem('watcher.user') ?? 'null');
const canOperate = user && (user.role === 'operator' || user.role === 'admin');

function renderTiles(summary) {
  const totalHosts = summary.hosts.up + summary.hosts.down + summary.hosts.unreachable;
  const totalSvcs = summary.services.ok + summary.services.warning
    + summary.services.critical + summary.services.unknown;
  const pct = (n, total) => (total > 0 ? Math.max(2, Math.round((n / total) * 100)) : 0);

  // Aura stat cards: label-caps, display number, faint icon, glowing meter.
  const tiles = [
    ['Systems Up', summary.hosts.up, 'ok', 'check_circle', pct(summary.hosts.up, totalHosts)],
    ['Systems Down', summary.hosts.down, summary.hosts.down > 0 ? 'critical' : '', 'cancel', pct(summary.hosts.down, totalHosts)],
    ['Unreachable', summary.hosts.unreachable, summary.hosts.unreachable > 0 ? 'warning' : '', 'signal_disconnected', pct(summary.hosts.unreachable, totalHosts)],
    ['Services OK', summary.services.ok, 'ok', 'task_alt', pct(summary.services.ok, totalSvcs)],
    ['Warnings', summary.services.warning, summary.services.warning > 0 ? 'warning' : '', 'warning', pct(summary.services.warning, totalSvcs)],
    ['Critical Alerts', summary.services.critical, summary.services.critical > 0 ? 'critical' : '', 'gpp_maybe', pct(summary.services.critical, totalSvcs)],
  ];
  document.getElementById('tiles').innerHTML = tiles.map(([label, value, cls, icon, meterPct]) => `
    <div class="tile ${cls}">
      <span class="material-symbols-outlined tile-icon">${icon}</span>
      <div class="label">${label}</div>
      <div class="value">${value}</div>
      <div class="meter"><i style="width:${value > 0 ? meterPct : 0}%"></i></div>
    </div>`).join('');
}

function renderState({ hosts, services }) {
  const bad = [...hosts.filter((h) => h.state !== 0), ...services.filter((s) => s.state !== 0)];
  problems.rows = bad
    .sort((a, b) => b.state - a.state)
    .map((o) => ({
      host: o.host,
      service: o.service,
      stateName: o.kind === 'host'
        ? ['UP', 'DOWN', 'UNREACHABLE'][o.state]
        : ['OK', 'WARNING', 'CRITICAL', 'UNKNOWN'][o.state],
      output: o.output,
      chipClass: chipClassFor(o),
    }));

  heatmap.cells = services.map((s) => ({
    id: `${s.host}/${s.service}`,
    label: `${s.host} / ${s.service}`,
    state: ['ok', 'warning', 'critical', 'unknown'][s.state] ?? 'unknown',
  }));
}

async function refresh() {
  const [summary, state] = await Promise.all([
    api('/nagios/summary'),
    api('/nagios/state'),
  ]);
  const total = summary.hosts.up + summary.hosts.down + summary.hosts.unreachable
    + summary.services.ok + summary.services.warning + summary.services.critical + summary.services.unknown;

  // Guided first-run: an empty operations centre gets a way to fill itself in
  // one click instead of a blank screen (time-to-value).
  if (total === 0) {
    live.hidden = true;
    await renderFirstRun();
    return;
  }
  live.hidden = false;
  firstrun.hidden = true;

  renderTiles(summary);
  shell.setHealth(summary);
  renderState(state);
  refreshDemoBanner();
  maybeTour();
}

// ── First-run guided tour: anchored to the live panels, shows once ──────────
let tourStarted = false;
function maybeTour() {
  if (tourStarted || tourSeen('watcher.tour.v1')) return;
  tourStarted = true;
  // Give the board one paint so every anchor exists and has size.
  setTimeout(() => startTour([
    { el: '#tiles', title: 'Health at a glance',
      body: 'Fleet-wide status tiles. Anything non-zero in Down, Unreachable or Critical deserves a look.' },
    { el: '#feed', title: 'Live events',
      body: 'Every state change and alert as it happens, primed with recent history — the pulse of the estate.' },
    { el: '#problems', title: 'Active problems',
      body: 'What is broken right now, worst first. Dependency-suppressed children are folded under their root cause in Alerts.' },
    { el: '#w-search-btn', title: 'Jump anywhere',
      body: 'Press `Ctrl` `K` (or `⌘K`) to jump to any page or device, run actions, or type `?` for every shortcut.' },
    { el: '#w-theme', title: 'Make it yours',
      body: 'Toggle light or dark. Watcher follows your OS preference until you choose.' },
  ], { key: 'watcher.tour.v1' }), 450);
}

async function renderFirstRun() {
  firstrun.hidden = false;
  const tips = [
    ['warning', 'Alert Correlation', 'See a real incident storm folded under one root cause.', '/alerts.html'],
    ['hub', 'Live Topology', 'Walk the L2/L3 map with node colour driven by live state.', '/topology.html'],
    ['monitoring', 'SLA Reporting', 'Run an availability report over the seeded history.', '/reports.html'],
  ];
  firstrun.innerHTML = `
    <div class="card" style="text-align:center;padding:44px 28px;margin-bottom:16px;
         background:radial-gradient(120% 140% at 50% -20%, var(--accent-soft), transparent 60%), var(--bg-raised)">
      <span class="material-symbols-outlined" style="font-size:48px;color:var(--accent)">radar</span>
      <h1 style="margin:14px 0 4px">Your operations centre is empty</h1>
      <p class="dim" style="max-width:52ch;margin:0 auto 22px">
        Connect a Nagios engine and pollers to watch real infrastructure — or load a realistic
        demo fleet right now and see Watcher fully alive in a few seconds.</p>
      ${canOperate
        ? `<button class="btn primary" id="load-demo" style="font-size:15px;padding:11px 22px">
             <span class="material-symbols-outlined">bolt</span>Load demo environment</button>
           <div id="load-status" class="mono dim" style="min-height:18px;margin-top:12px;font-size:12px"></div>`
        : `<div class="dim mono" style="font-size:12px">Ask an operator to load the demo environment.</div>`}
    </div>
    <div class="tiles" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">
      ${tips.map(([icon, t, d, href]) => `
        <a class="tile" href="${href}" style="text-decoration:none;display:block">
          <span class="material-symbols-outlined tile-icon">${icon}</span>
          <div class="label" style="color:var(--accent-text)">${t}</div>
          <div style="color:var(--text);font-size:14px;margin-top:6px;line-height:1.4">${d}</div>
        </a>`).join('')}
    </div>`;

  const btn = firstrun.querySelector('#load-demo');
  if (btn) {
    btn.addEventListener('click', async () => {
      const status = firstrun.querySelector('#load-status');
      btn.disabled = true;
      status.style.color = 'var(--text-dim)';
      status.textContent = 'Provisioning a demo fleet, states, metrics and alerts…';
      try {
        const res = await api('/demo/seed', { method: 'POST' });
        status.style.color = 'var(--ok)';
        status.textContent = `Loaded ${res.devices} devices and ${res.services} services. Bringing the board to life…`;
        setTimeout(() => { refresh().catch(() => {}); refreshCpu(); }, 700);
      } catch (err) {
        status.style.color = 'var(--critical)';
        status.textContent = `Could not load demo: ${err.message}`;
        btn.disabled = false;
      }
    });
  }
}

async function refreshDemoBanner() {
  try {
    const { loaded } = await api('/demo/status');
    demobanner.hidden = !loaded;
    if (loaded) {
      demobanner.innerHTML = `
        <div class="card" style="display:flex;align-items:center;gap:12px;padding:10px 16px;margin-bottom:12px;
             border-color:var(--border-strong)">
          <span class="material-symbols-outlined" style="color:var(--accent);font-size:20px">science</span>
          <span style="font-size:13px">You're viewing a <strong>demo environment</strong> — seeded devices, states, metrics and alerts.</span>
          ${canOperate ? `<button class="btn" id="clear-demo" style="margin-left:auto;font-size:12px">Clear demo data</button>` : ''}
        </div>`;
      const clr = demobanner.querySelector('#clear-demo');
      if (clr) clr.addEventListener('click', async () => {
        clr.disabled = true; clr.textContent = 'Clearing…';
        try { await api('/demo/seed', { method: 'DELETE' }); location.reload(); }
        catch { clr.disabled = false; clr.textContent = 'Clear demo data'; }
      });
    }
  } catch { demobanner.hidden = true; }
}

await refresh();
setInterval(() => refresh().catch(() => {}), 30_000);

// Prime the live feed with recent history so it reads as alive on first paint
// instead of "awaiting telemetry"; the WebSocket then prepends new events.
async function primeFeed() {
  try {
    const { events } = await api('/nagios/events/recent?limit=60');
    if (events?.length) feed.events = events;
  } catch { /* no history yet — the empty state is correct */ }
}
await primeFeed();

liveEvents(['state', 'alerts'], (channel, data) => {
  if (channel === 'state') {
    feed.push({
      severity: chipClassFor(data),
      chipClass: chipClassFor(data),
      title: `${data.host}${data.service ? ' / ' + data.service : ''} → ${data.stateName}`,
      detail: data.output,
      ts: data.ts,
    });
    refresh().catch(() => {});
  } else if (channel === 'alerts') {
    const a = data.alert;
    feed.push({
      severity: a.severity,
      chipClass: data.action === 'resolved' ? 'ok' : a.severity,
      title: `alert ${data.action}: ${a.device_name}${a.check_name ? ' / ' + a.check_name : ''}`,
      detail: a.message,
    });
  }
});

// Demo CPU gauge: average cpu.util.pct across devices reporting it recently.
async function refreshCpu() {
  try {
    const { devices } = await api('/devices?limit=25');
    let sum = 0, n = 0;
    for (const d of devices.slice(0, 10)) {
      const { values } = await api(`/metrics/latest?deviceId=${d.id}&metric=cpu.util.pct`);
      if (values[0]) { sum += values[0].value; n++; }
    }
    if (n > 0) document.getElementById('g-cpu').setAttribute('value', (sum / n).toFixed(1));
  } catch { /* metrics may be empty on a fresh install */ }
}
refreshCpu();
setInterval(refreshCpu, 60_000);
