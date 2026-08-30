import '@watcher/ui';
import { escapeHtml as esc, escapeAttr, toast, timeAgo } from '@watcher/ui';
import { api, requireAuth, liveEvents } from '../lib/api.js';

requireAuth();

const rowsEl = document.getElementById('rows');
const emptyEl = document.getElementById('empty');
const bulkbar = document.getElementById('bulkbar');
const me = JSON.parse(localStorage.getItem('watcher.user') ?? 'null');
const canOperate = me && (me.role === 'operator' || me.role === 'admin');

/** Selected alert ids for bulk actions (survives re-renders). */
const selected = new Set();

function statusChip(a) {
  return a.status === 'resolved' ? 'ok'
    : a.status === 'suppressed' ? 'suppressed'
    : a.status === 'acknowledged' ? 'info' : a.severity;
}

function renderBulkbar() {
  bulkbar.hidden = selected.size === 0;
  document.getElementById('bulk-count').textContent =
    `${selected.size} selected`;
}

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

  // Drop selections that no longer correspond to a visible, ackable alert.
  const ackable = new Set(alerts.filter((a) => a.status === 'open' || a.status === 'suppressed').map((a) => a.id));
  for (const id of selected) if (!ackable.has(id)) selected.delete(id);
  renderBulkbar();

  rowsEl.innerHTML = alerts.map((a) => {
    const selectable = a.status === 'open' || a.status === 'suppressed';
    const mine = me && a.assignee === me.username;
    return `
    <tr>
      <td>${selectable && canOperate
        ? `<input type="checkbox" data-sel="${escapeAttr(a.id)}" ${selected.has(a.id) ? 'checked' : ''}
             aria-label="Select alert on ${escapeAttr(a.device_name)}" />` : ''}</td>
      <td><span class="chip ${a.severity}">${a.severity}</span></td>
      <td><span class="chip ${statusChip(a)}">${a.status}</span></td>
      <td><strong>${esc(a.device_name)}</strong>${a.check_name ? `<span class="dim"> / ${esc(a.check_name)}</span>` : ''}
          ${a.flapping ? '<span class="chip warning" style="margin-left:6px">flapping</span>' : ''}</td>
      <td class="dim" style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.message)}</td>
      <td style="white-space:nowrap">${a.assignee
        ? `<span class="chip ${mine ? 'ok' : 'unknown'}" title="Assigned ${a.assigned_at ? timeAgo(a.assigned_at) + ' ago' : ''}">
             <span class="material-symbols-outlined" style="font-size:13px;vertical-align:-2px" aria-hidden="true">person</span>${esc(a.assignee)}</span>`
        : (canOperate && a.status !== 'resolved'
          ? `<button class="btn" data-claim="${escapeAttr(a.id)}" style="font-size:11px;padding:3px 9px"
               aria-label="Assign alert on ${escapeAttr(a.device_name)} to me">
               <span class="material-symbols-outlined" style="font-size:14px" aria-hidden="true">person_add</span>Take</button>`
          : '<span class="dim">—</span>')}</td>
      <td class="num">${a.occurrences}</td>
      <td class="dim mono" style="white-space:nowrap" title="${escapeAttr(new Date(a.opened_at).toLocaleString())}">${timeAgo(a.opened_at)} ago</td>
      <td style="white-space:nowrap">
        <button class="btn" data-rb="${escapeAttr(a.id)}" title="Runbook" aria-label="Show runbook for ${escapeAttr(a.device_name)}" style="padding:4px 8px">
          <span class="material-symbols-outlined" style="font-size:16px" aria-hidden="true">menu_book</span></button>
        ${a.status === 'open' && canOperate ? `<button class="btn" data-ack="${escapeAttr(a.id)}" data-host="${escapeAttr(a.device_name)}" data-svc="${escapeAttr(a.check_name)}">Ack</button>` : ''}
      </td>
    </tr>
    <tr class="rb-row" id="rb-${escapeAttr(a.id)}" hidden><td colspan="9" style="background:var(--bg-deep)"></td></tr>`;
  }).join('');

  rowsEl.querySelectorAll('[data-sel]').forEach((cb) => cb.addEventListener('change', () => {
    cb.checked ? selected.add(cb.dataset.sel) : selected.delete(cb.dataset.sel);
    renderBulkbar();
  }));

  rowsEl.querySelectorAll('[data-claim]').forEach((btn) => btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await api(`/alerts/${btn.dataset.claim}/assign`, { method: 'POST', body: {} });
      toast('Assigned to you', { type: 'success' });
      load();
    } catch (err) { btn.disabled = false; toast(`Could not assign: ${err.message}`, { type: 'error' }); }
  }));

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

// ── Bulk actions ────────────────────────────────────────────────────────────
document.getElementById('sel-all').addEventListener('change', (e) => {
  rowsEl.querySelectorAll('[data-sel]').forEach((cb) => {
    cb.checked = e.target.checked;
    cb.checked ? selected.add(cb.dataset.sel) : selected.delete(cb.dataset.sel);
  });
  renderBulkbar();
});

document.getElementById('bulk-clear').addEventListener('click', () => {
  selected.clear();
  rowsEl.querySelectorAll('[data-sel]').forEach((cb) => { cb.checked = false; });
  document.getElementById('sel-all').checked = false;
  renderBulkbar();
});

document.getElementById('bulk-ack').addEventListener('click', async () => {
  if (selected.size === 0) return;
  const comment = prompt(`Acknowledgement comment for ${selected.size} alert(s):`);
  if (!comment) return;
  try {
    const { acknowledged } = await api('/alerts/bulk-ack', {
      method: 'POST', body: { ids: [...selected], comment },
    });
    toast(`Acknowledged ${acknowledged} alert(s)`, { type: 'success' });
    selected.clear();
    document.getElementById('sel-all').checked = false;
    load();
  } catch (err) { toast(`Bulk acknowledge failed: ${err.message}`, { type: 'error' }); }
});

// ── Saved views (per-browser) ───────────────────────────────────────────────
const VIEWS_KEY = 'watcher.alertViews';
const viewSel = document.getElementById('f-view');

function readViews() {
  try { return JSON.parse(localStorage.getItem(VIEWS_KEY) ?? '[]'); } catch { return []; }
}
function renderViews() {
  const views = readViews();
  viewSel.innerHTML = '<option value="">Views…</option>'
    + views.map((v, i) => `<option value="${i}">${esc(v.name)}</option>`).join('')
    + (views.length ? '<option value="__manage">✕ Delete a view…</option>' : '');
}
viewSel.addEventListener('change', () => {
  const views = readViews();
  if (viewSel.value === '__manage') {
    const name = prompt(`Delete which view?\n${views.map((v) => `• ${v.name}`).join('\n')}\n\nType its exact name:`);
    if (name) {
      localStorage.setItem(VIEWS_KEY, JSON.stringify(views.filter((v) => v.name !== name)));
      toast(`View "${name}" deleted`, { type: 'info' });
    }
    renderViews(); viewSel.value = '';
    return;
  }
  const v = views[Number(viewSel.value)];
  if (!v) return;
  document.getElementById('f-status').value = v.status ?? '';
  document.getElementById('f-severity').value = v.severity ?? '';
  document.getElementById('f-device').value = v.device ?? '';
  load();
});
document.getElementById('save-view').addEventListener('click', () => {
  const name = prompt('Name this view (e.g. "Criticals · core"):');
  if (!name) return;
  const views = readViews().filter((v) => v.name !== name);
  views.push({
    name,
    status: document.getElementById('f-status').value,
    severity: document.getElementById('f-severity').value,
    device: document.getElementById('f-device').value.trim(),
  });
  localStorage.setItem(VIEWS_KEY, JSON.stringify(views));
  renderViews();
  toast(`View "${name}" saved`, { type: 'success' });
});
renderViews();

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
         <span class="material-symbols-outlined" style="font-size:15px" aria-hidden="true">open_in_new</span>${esc(l.label)}</a>`).join(' ');
    cell.innerHTML = `
      <div style="padding:16px 18px;border-left:3px solid var(--accent)">
        <div class="row" style="gap:8px;margin-bottom:10px">
          <span class="material-symbols-outlined" style="color:var(--accent)" aria-hidden="true">menu_book</span>
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
