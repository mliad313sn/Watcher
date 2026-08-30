import '@watcher/ui';
import { escapeHtml as esc, escapeAttr, toast, timeAgo } from '@watcher/ui';
import { api, requireAuth, liveEvents } from '../lib/api.js';

requireAuth();

const rowsEl = document.getElementById('rows');
const emptyEl = document.getElementById('empty');

async function load() {
  const p = new URLSearchParams();
  const status = document.getElementById('f-status').value;
  const severity = document.getElementById('f-severity').value;
  const device = document.getElementById('f-device').value.trim();
  if (status) p.set('status', status);
  if (severity) p.set('severity', severity);
  if (device) p.set('device', device);

  let { alerts } = await api(`/alerts?${p}`);
  if (!status) alerts = alerts.filter((a) => a.status !== 'resolved');
  emptyEl.hidden = alerts.length > 0;

  rowsEl.innerHTML = alerts.map((a) => `
    <tr>
      <td><span class="chip ${a.severity}">${a.severity}</span></td>
      <td><span class="chip ${a.status === 'resolved' ? 'ok' : a.status === 'suppressed' ? 'suppressed' : a.status === 'acknowledged' ? 'info' : a.severity}">${a.status}</span></td>
      <td><strong>${esc(a.device_name)}</strong>${a.check_name ? `<span class="dim"> / ${esc(a.check_name)}</span>` : ''}
          ${a.flapping ? '<span class="chip warning" style="margin-left:6px">flapping</span>' : ''}</td>
      <td class="dim" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.message)}</td>
      <td class="num">${a.occurrences}</td>
      <td class="dim mono" style="white-space:nowrap" title="${escapeAttr(new Date(a.opened_at).toLocaleString())}">${timeAgo(a.opened_at)} ago</td>
      <td style="white-space:nowrap">
        <button class="btn" data-rb="${escapeAttr(a.id)}" title="Runbook" aria-label="Show runbook for ${escapeAttr(a.device_name)}" style="padding:4px 8px">
          <span class="material-symbols-outlined" style="font-size:16px" aria-hidden="true">menu_book</span></button>
        ${a.status === 'open' ? `<button class="btn" data-ack="${escapeAttr(a.id)}" data-host="${escapeAttr(a.device_name)}" data-svc="${escapeAttr(a.check_name)}">Ack</button>` : ''}
      </td>
    </tr>
    <tr class="rb-row" id="rb-${escapeAttr(a.id)}" hidden><td colspan="7" style="background:var(--bg-deep)"></td></tr>`).join('');

  rowsEl.querySelectorAll('[data-rb]').forEach((btn) => {
    btn.addEventListener('click', () => toggleRunbook(btn.dataset.rb));
  });

  rowsEl.querySelectorAll('[data-ack]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const comment = prompt('Acknowledgement comment:');
      if (!comment) return;
      btn.disabled = true;
      try {
        // Ack in Watcher and mirror into Nagios so notifications stop there too.
        await api(`/alerts/${btn.dataset.ack}/ack`, { method: 'POST', body: { comment } });
        await api('/nagios/ack', {
          method: 'POST',
          body: { host: btn.dataset.host, service: btn.dataset.svc || undefined, comment },
        }).catch(() => {});
        toast(`Acknowledged ${btn.dataset.host}${btn.dataset.svc ? ' / ' + btn.dataset.svc : ''}`, { type: 'success' });
        load();
      } catch (err) {
        btn.disabled = false;
        toast(`Could not acknowledge: ${err.message}`, { type: 'error' });
      }
    });
  });
}

async function toggleRunbook(alertId) {
  const row = document.getElementById(`rb-${alertId}`);
  if (!row) return;
  if (!row.hidden) { row.hidden = true; return; }
  row.hidden = false;
  const cell = row.firstElementChild;
  if (cell.dataset.loaded) return;
  cell.dataset.loaded = '1';
  cell.innerHTML = '<div class="dim mono" style="padding:12px;font-size:12px">Loading runbook…</div>';
  try {
    const { runbook } = await api(`/runbooks/for-alert/${alertId}`);
    if (!runbook) {
      cell.innerHTML = '<div class="dim" style="padding:14px;font-size:13px">No runbook applies to this alert. '
        + '<a href="/settings.html">Add one in Admin →</a></div>';
      return;
    }
    const steps = esc(runbook.steps || '').split('\n').filter(Boolean)
      .map((s) => `<div style="padding:3px 0">${s}</div>`).join('');
    const links = (runbook.links || []).map((l) =>
      `<a href="${escapeAttr(l.url)}" target="_blank" rel="noopener" class="btn" style="font-size:12px">
         <span class="material-symbols-outlined" style="font-size:15px">open_in_new</span>${esc(l.label)}</a>`).join(' ');
    cell.innerHTML = `
      <div style="padding:16px 18px;border-left:3px solid var(--accent)">
        <div class="row" style="gap:8px;margin-bottom:10px">
          <span class="material-symbols-outlined" style="color:var(--accent)">menu_book</span>
          <strong style="font-size:15px">${esc(runbook.name)}</strong>
        </div>
        <div class="label-caps" style="margin-bottom:4px">Remediation</div>
        <div class="mono" style="font-size:13px;line-height:1.55;color:var(--text)">${steps || '<span class="dim">No steps recorded.</span>'}</div>
        ${links ? `<div class="label-caps" style="margin:14px 0 6px">Links</div><div class="row" style="gap:8px;flex-wrap:wrap">${links}</div>` : ''}
      </div>`;
  } catch {
    cell.innerHTML = '<div class="dim" style="padding:14px">Could not load runbook.</div>';
  }
}

for (const id of ['f-status', 'f-severity']) {
  document.getElementById(id).addEventListener('change', load);
}
document.getElementById('f-device').addEventListener('input', (() => {
  let t;
  return () => { clearTimeout(t); t = setTimeout(load, 300); };
})());

await load();
liveEvents(['alerts'], () => load().catch(() => {}));
