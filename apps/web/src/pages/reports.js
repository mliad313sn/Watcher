import '@watcher/ui';
import { escapeHtml as esc, escapeAttr, toast } from '@watcher/ui';
import { api, requireAuth } from '../lib/api.js';

requireAuth();

// ── Fleet SLA (all devices, worst first) ────────────────────────────────────
async function loadSla() {
  const days = document.getElementById('sla-days').value;
  const rowsEl = document.getElementById('sla-rows');
  try {
    const { rows } = await api(`/metrics/sla?days=${days}`);
    if (rows.length === 0) {
      rowsEl.innerHTML = '<tr><td colspan="5" class="empty">No devices yet.</td></tr>';
      return;
    }
    const fmtDown = (s) => s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
      : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
    rowsEl.innerHTML = rows.map((r) => `
      <tr>
        <td><strong>${esc(r.device)}</strong></td>
        <td class="dim">${esc(r.kind)}</td>
        <td class="num mono" style="color:${r.availabilityPct >= 99.9 ? 'var(--ok)' : r.availabilityPct >= 99 ? 'var(--warning)' : 'var(--critical)'}">${r.availabilityPct.toFixed(3)}%</td>
        <td class="num mono">${fmtDown(r.downtimeSeconds)}</td>
        <td class="num mono">${r.outages}</td>
      </tr>`).join('');
  } catch (err) {
    rowsEl.innerHTML = `<tr><td colspan="5" class="empty">Could not load SLA: ${esc(err.message)}</td></tr>`;
  }
}
document.getElementById('sla-days').addEventListener('change', loadSla);
document.getElementById('sla-csv').addEventListener('click', async () => {
  const days = document.getElementById('sla-days').value;
  try {
    // fetch with auth then hand the blob to the browser — a plain link can't
    // carry the Authorization header.
    const res = await fetch(`/api/metrics/sla?days=${days}&format=csv`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('watcher.token')}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `watcher-sla-${days}d.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('SLA report downloaded', { type: 'success' });
  } catch (err) { toast(`Export failed: ${err.message}`, { type: 'error' }); }
});
await loadSla();

const deviceSel = document.getElementById('r-device');

const { devices } = await api('/devices?limit=1000');
deviceSel.innerHTML = devices
  .map((d) => `<option value="${escapeAttr(d.name)}">${esc(d.name)}</option>`)
  .join('');

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
