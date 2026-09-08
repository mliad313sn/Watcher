import '@watcher/ui';
import { escapeHtml as esc, escapeAttr, toast, timeAgo } from '@watcher/ui';
import { api, requireAuth } from '../lib/api.js';

requireAuth();

const me = JSON.parse(localStorage.getItem('watcher.user') ?? 'null');
const canRead = me && (me.role === 'operator' || me.role === 'admin');

/**
 * Drift is a four-state word, and the fourth matters most: "unapproved"
 * means nobody has said what this device should be, which is not a fault.
 */
const DRIFT_CHIP = {
  compliant: 'ok', drifted: 'warning', unapproved: 'info', unknown: 'suppressed',
};
const DRIFT_LABEL = {
  compliant: 'matches baseline', drifted: 'drifted', unapproved: 'no baseline',
  unknown: 'never captured',
};

const PROXY_CHIP = {
  healthy: 'ok', behind: 'warning', silent: 'critical',
  'never connected': 'info', disabled: 'suppressed', unknown: 'suppressed',
};

async function loadProxies() {
  const { proxies } = await api('/proxy');
  document.getElementById('proxies-empty').hidden = proxies.length > 0;
  document.getElementById('proxies').innerHTML = proxies.map((p) => `
    <tr>
      <td>${esc(p.name)}${p.enrolment_pending ? ' <span class="sub">(awaiting enrolment)</span>' : ''}</td>
      <td>${esc(p.site || '—')}</td>
      <td><span class="chip ${PROXY_CHIP[p.health] ?? 'info'}">${esc(p.health)}</span>
          ${p.queue_depth ? `<span class="sub"> ${p.queue_depth} queued</span>` : ''}</td>
      <td class="num">${p.devices}</td>
      <td>${p.last_seen_at ? esc(timeAgo(p.last_seen_at)) : '<span class="sub">never</span>'}</td>
    </tr>`).join('');
}

async function loadConfigs() {
  const { devices } = await api('/configs');
  document.getElementById('empty').hidden = devices.length > 0;
  document.getElementById('rows').innerHTML = devices.map((d) => `
    <tr>
      <td><a href="/device.html?id=${escapeAttr(d.device_id)}">${esc(d.device_name)}</a></td>
      <td>${esc(d.vendor)}</td>
      <td><span class="chip ${DRIFT_CHIP[d.drift] ?? 'info'}">${esc(DRIFT_LABEL[d.drift] ?? d.drift)}</span>
          ${d.stale ? ' <span class="chip critical" title="the last capture failed — the history is going stale">capture failing</span>' : ''}</td>
      <td>${d.captured_at ? esc(timeAgo(d.captured_at)) : '<span class="sub">never</span>'}</td>
      <td class="num">${d.lines_added || d.lines_removed
        ? `<span style="color:var(--ok)">+${d.lines_added}</span> <span style="color:var(--critical)">-${d.lines_removed}</span>`
        : '—'}</td>
      <td>${d.baseline_hash
        ? `<span class="sub">${esc(d.approved_by ?? 'approved')} · ${esc(timeAgo(d.approved_at))}</span>`
        : '<span class="sub">none</span>'}</td>
      <td>${canRead && d.current_hash
        ? `<button class="btn" data-diff="${escapeAttr(d.device_id)}" data-name="${escapeAttr(d.device_name)}"
             style="font-size:12px;padding:4px 10px">Diff</button>` : ''}</td>
    </tr>`).join('');

  for (const button of document.querySelectorAll('[data-diff]')) {
    button.addEventListener('click', () => showDiff(button.dataset.diff, button.dataset.name));
  }
}

/** Render a unified diff. Colour carries meaning, the sign carries it too. */
function renderDiff(diff) {
  if (diff.truncated) return 'The configuration is too large to diff line by line.';
  if (!diff.hunks.length) return 'No differences.';
  return diff.hunks.map((h) => h.lines.map((l) => {
    const colour = l.op === '+' ? 'var(--ok)' : l.op === '-' ? 'var(--critical)' : 'var(--text-dim)';
    return `<span style="color:${colour}">${esc(l.op)} ${esc(l.line)}</span>`;
  }).join('\n')).join('\n<span class="sub">   ⋯</span>\n');
}

async function showDiff(deviceId, name) {
  const card = document.getElementById('diff-card');
  try {
    const out = await api(`/configs/${deviceId}/diff`);
    document.getElementById('diff-title').textContent = `${name} — against the approved baseline`;
    document.getElementById('diff-sub').textContent = out.note
      ?? `${out.diff.added} added, ${out.diff.removed} removed`;
    document.getElementById('diff-body').innerHTML = renderDiff(out.diff);
    card.hidden = false;
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    toast(`Could not load the diff: ${err.message}`, 'error');
  }
}

document.getElementById('diff-close').addEventListener('click', () => {
  document.getElementById('diff-card').hidden = true;
});

try {
  await Promise.all([loadProxies(), loadConfigs()]);
} catch (err) {
  toast(`Could not load: ${err.message}`, 'error');
}
setInterval(() => Promise.all([loadProxies(), loadConfigs()]).catch(() => {}), 60_000);
