import '@watcher/ui';
import { api, requireAuth, liveEvents, chipClassFor } from '../lib/api.js';

requireAuth();

const shell = document.querySelector('w-shell');
const feed = document.getElementById('feed');
const problems = document.getElementById('problems');
const heatmap = document.getElementById('heatmap');

function renderTiles(summary) {
  const tiles = [
    ['Hosts up', summary.hosts.up, 'ok'],
    ['Hosts down', summary.hosts.down, summary.hosts.down > 0 ? 'critical' : ''],
    ['Unreachable', summary.hosts.unreachable, summary.hosts.unreachable > 0 ? 'warning' : ''],
    ['Services OK', summary.services.ok, 'ok'],
    ['Warning', summary.services.warning, summary.services.warning > 0 ? 'warning' : ''],
    ['Critical', summary.services.critical, summary.services.critical > 0 ? 'critical' : ''],
    ['Acknowledged', summary.acknowledged, ''],
  ];
  document.getElementById('tiles').innerHTML = tiles.map(([label, value, cls]) => `
    <div class="tile ${cls}">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
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
  renderTiles(summary);
  shell.setHealth(summary);
  renderState(state);
}

await refresh();
setInterval(() => refresh().catch(() => {}), 30_000);

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
