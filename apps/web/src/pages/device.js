import '@watcher/ui';
import { api, requireAuth, chipClassFor } from '../lib/api.js';

requireAuth();

const params = new URLSearchParams(location.search);
const deviceId = params.get('id');
const deviceName = params.get('name') ?? '';

if (!deviceId) location.href = '/devices.html';

const traffic = document.getElementById('traffic');
const ifaceSel = document.getElementById('iface');

async function loadDevice() {
  const { device } = await api(`/devices/${deviceId}`);
  document.getElementById('name').textContent = device.name;
  document.getElementById('meta').textContent =
    [device.address, device.kind, device.vendor, device.model, device.location]
      .filter(Boolean).join(' · ');
  document.title = `${device.name} · Watcher`;
}

async function loadGauges() {
  for (const [metric, gaugeId] of [['cpu.util.pct', 'g-cpu'], ['mem.used.pct', 'g-mem']]) {
    try {
      const { values } = await api(`/metrics/latest?deviceId=${deviceId}&metric=${metric}`);
      if (values[0]) document.getElementById(gaugeId).setAttribute('value', values[0].value.toFixed(1));
    } catch { /* no data yet */ }
  }
  try {
    const { values } = await api(`/metrics/latest?deviceId=${deviceId}&metric=sys.uptime.s`);
    if (values[0]) {
      const days = values[0].value / 86400;
      document.getElementById('uptime').textContent =
        days >= 1 ? `${days.toFixed(1)}d` : `${(values[0].value / 3600).toFixed(1)}h`;
    }
  } catch { /* ignore */ }
  try {
    const { values } = await api(`/metrics/latest?deviceId=${deviceId}&metric=if.oper.up`);
    const up = values.filter((v) => v.value === 1);
    document.getElementById('ifup').textContent = `${up.length}/${values.length}`;
    ifaceSel.innerHTML = values.map((v) =>
      `<option ${v.value !== 1 ? 'disabled' : ''}>${v.instance}</option>`).join('');
  } catch { /* ignore */ }
}

async function loadTraffic() {
  const iface = ifaceSel.value;
  if (!iface) return;
  const hours = Number(document.getElementById('range').value);
  const from = new Date(Date.now() - hours * 3600e3).toISOString();
  try {
    const [inSeries, outSeries] = await Promise.all([
      api(`/metrics/query?deviceId=${deviceId}&metric=if.in.bps&instance=${encodeURIComponent(iface)}&from=${from}`),
      api(`/metrics/query?deviceId=${deviceId}&metric=if.out.bps&instance=${encodeURIComponent(iface)}&from=${from}`),
    ]);
    traffic.series = {
      in: inSeries.series.map((r) => ({ t: r.time, v: r.avg_value })),
      out: outSeries.series.map((r) => ({ t: r.time, v: r.avg_value })),
    };
    document.getElementById('if-label').textContent = `· ${iface}`;
  } catch { /* ignore */ }
}

async function loadServices() {
  try {
    const { services } = await api('/nagios/state');
    const mine = services.filter((s) => s.host === deviceName);
    document.getElementById('services').rows = mine.map((s) => ({
      host: s.host,
      service: s.service,
      stateName: ['OK', 'WARNING', 'CRITICAL', 'UNKNOWN'][s.state],
      output: s.output,
      chipClass: chipClassFor(s),
    }));
  } catch { /* engine may be offline */ }
}

document.getElementById('range').addEventListener('change', loadTraffic);
ifaceSel.addEventListener('change', loadTraffic);
document.getElementById('recheck').addEventListener('click', async () => {
  if (deviceName) await api('/nagios/recheck', { method: 'POST', body: { host: deviceName } });
});

await loadDevice();
await loadGauges();
await loadTraffic();
await loadServices();
setInterval(() => { loadGauges(); loadTraffic(); loadServices(); }, 60_000);
