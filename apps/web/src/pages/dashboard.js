import '@watcher/ui';
import { api, requireAuth, liveEvents, chipClassFor } from '../lib/api.js';

requireAuth();

const shell = document.querySelector('w-shell');
const feed = document.getElementById('feed');
const problems = document.getElementById('problems');
const heatmap = document.getElementById('heatmap');

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
