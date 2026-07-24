import '@watcher/ui';
import { escapeHtml as esc, escapeAttr } from '@watcher/ui';
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
      <td class="dim" style="max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.message)}</td>
      <td class="num">${a.occurrences}</td>
      <td class="dim mono" style="white-space:nowrap">${new Date(a.opened_at).toLocaleString()}</td>
      <td>${a.status === 'open' ? `<button class="btn" data-ack="${escapeAttr(a.id)}" data-host="${escapeAttr(a.device_name)}" data-svc="${escapeAttr(a.check_name)}">Ack</button>` : ''}</td>
    </tr>`).join('');

  rowsEl.querySelectorAll('[data-ack]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const comment = prompt('Acknowledgement comment:');
      if (!comment) return;
      // Ack in Watcher and mirror into Nagios so notifications stop there too.
      await api(`/alerts/${btn.dataset.ack}/ack`, { method: 'POST', body: { comment } });
      await api('/nagios/ack', {
        method: 'POST',
        body: { host: btn.dataset.host, service: btn.dataset.svc || undefined, comment },
      }).catch(() => {});
      load();
    });
  });
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
