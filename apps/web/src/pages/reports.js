import '@watcher/ui';
import { api, requireAuth } from '../lib/api.js';

requireAuth();

const deviceSel = document.getElementById('r-device');

const { devices } = await api('/devices?limit=1000');
deviceSel.innerHTML = devices.map((d) => `<option value="${d.name}">${d.name}</option>`).join('');

function esc(s) {
  return String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function fmtDuration(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

document.getElementById('run').addEventListener('click', async () => {
  const device = deviceSel.value;
  if (!device) return;
  const check = document.getElementById('r-check').value.trim();
  const days = document.getElementById('r-days').value;

  const p = new URLSearchParams({ device, days });
  if (check) p.set('check', check);
  const report = await api(`/metrics/availability?${p}`);

  document.getElementById('result').hidden = false;
  const pctEl = document.getElementById('r-pct');
  pctEl.textContent = `${report.availabilityPct}%`;
  pctEl.style.color = report.availabilityPct >= 99.9 ? 'var(--ok)'
    : report.availabilityPct >= 99 ? 'var(--warning)' : 'var(--critical)';
  document.getElementById('r-down').textContent = fmtDuration(report.downtimeSeconds);
  document.getElementById('r-outages').textContent =
    report.transitions.filter((t) => t.to_state !== 0).length;

  document.getElementById('r-rows').innerHTML = report.transitions.map((t) => `
    <tr>
      <td class="mono dim" style="white-space:nowrap">${new Date(t.time).toLocaleString()}</td>
      <td><span class="chip ${t.to_state === 0 ? 'ok' : 'critical'}">${t.from_state} → ${t.to_state}</span></td>
      <td class="dim">${esc(t.output ?? '')}</td>
    </tr>`).join('') || '<tr><td colspan="3" class="empty">No transitions in window — 100% steady.</td></tr>';
});
