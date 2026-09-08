import '@watcher/ui';
import { escapeHtml as esc, escapeAttr, toast, timeAgo } from '@watcher/ui';
import { api, requireAuth } from '../lib/api.js';

requireAuth();

const rowsEl = document.getElementById('rows');
const emptyEl = document.getElementById('empty');
const sendersEl = document.getElementById('senders');
const rulesEl = document.getElementById('rules');

const SEVERITY_NAMES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];

/** Colour an event the way the operator reads it: by what it did, then by how bad it is. */
function severityChip(e) {
  if (e.action === 'alert') return 'critical';
  if (e.action === 'clear') return 'ok';
  if (e.severity === null || e.severity === undefined) return 'info';
  if (e.severity <= 2) return 'critical';
  if (e.severity <= 4) return 'warning';
  return 'info';
}

function severityLabel(e) {
  if (e.severity === null || e.severity === undefined) return e.source === 'trap' ? 'trap' : '—';
  return `${e.severity} ${SEVERITY_NAMES[e.severity] ?? ''}`.trim();
}

/**
 * Say what happened to the event, and because of which rule. "Why did this
 * page me" should be answerable from the row, not from the rule list — the
 * rule may have been edited since.
 */
function outcome(e) {
  const rule = e.rule_name ? ` · ${esc(e.rule_name)}` : '';
  if (e.action === 'alert') return `<span class="chip critical">raised</span>${rule}`;
  if (e.action === 'clear') return `<span class="chip ok">cleared</span>${rule}`;
  if (e.action === 'drop') return `<span class="chip suppressed">dropped</span>${rule}`;
  return `<span class="chip info">logged</span>${rule}`;
}

async function loadEvents() {
  const p = new URLSearchParams();
  for (const [id, key] of [['f-source', 'source'], ['f-action', 'action'],
    ['f-severity', 'maxSeverity'], ['f-device', 'device'], ['f-q', 'q']]) {
    const value = document.getElementById(id).value.trim();
    if (value) p.set(key, value);
  }

  const { events } = await api(`/events?${p}`);
  emptyEl.hidden = events.length > 0;

  rowsEl.innerHTML = events.map((e) => `
    <tr>
      <td title="${escapeAttr(new Date(e.time).toISOString())}">${esc(timeAgo(e.time))}</td>
      <td><span class="chip info">${esc(e.source)}</span></td>
      <td>${e.device_id
        ? `<a href="/device.html?id=${escapeAttr(e.device_id)}">${esc(e.device_name)}</a>`
        : `${esc(e.device_name)} <span class="sub">(unknown)</span>`}</td>
      <td><span class="chip ${severityChip(e)}">${esc(severityLabel(e))}</span></td>
      <td>
        ${e.oid ? `<code style="font-size:11px">${esc(e.oid)}</code><br />` : ''}
        ${e.app_name ? `<strong>${esc(e.app_name)}</strong> ` : ''}${esc(e.message)}
      </td>
      <td>${outcome(e)}</td>
    </tr>`).join('');
}

async function loadSenders() {
  const { senders } = await api('/events/summary?hours=24');
  document.getElementById('senders-empty').hidden = senders.length > 0;
  sendersEl.innerHTML = senders.slice(0, 8).map((s) => `
    <tr>
      <td>${esc(s.device_name || '—')}</td>
      <td><span class="chip info">${esc(s.source)}</span></td>
      <td class="num">${Number(s.events).toLocaleString()}</td>
      <td class="num">${Number(s.alerting).toLocaleString()}</td>
    </tr>`).join('');
}

/** Render a rule's selectors the way its author would describe them out loud. */
function selects(r) {
  const parts = [];
  if (r.source && r.source !== 'any') parts.push(esc(r.source));
  if (r.matchOid) parts.push(`OID <code style="font-size:11px">${esc(r.matchOid)}</code>`);
  if (r.matchApp) parts.push(`app ${esc(r.matchApp)}`);
  if (r.matchFacility !== null && r.matchFacility !== undefined) parts.push(`facility ${r.matchFacility}`);
  if (r.maxSeverity !== null && r.maxSeverity !== undefined) {
    parts.push(`${esc(SEVERITY_NAMES[r.maxSeverity] ?? r.maxSeverity)} and worse`);
  }
  if (r.matchPattern) parts.push(`matching <code style="font-size:11px">${esc(r.matchPattern)}</code>`);
  return parts.length ? parts.join(' · ') : '<span class="sub">everything</span>';
}

function does(r) {
  if (r.action === 'drop') return '<span class="chip suppressed">drop</span>';
  if (r.action === 'log') return '<span class="chip info">log only</span>';
  if (r.action === 'clear') return `<span class="chip ok">clear</span> ${esc(r.checkName)}`;
  const clears = r.autoClearSeconds
    ? ` <span class="sub">· closes after ${Math.round(r.autoClearSeconds / 60)}m quiet</span>`
    : ' <span class="sub">· stays until closed by hand</span>';
  return `<span class="chip ${esc(r.severity)}">${esc(r.severity)}</span> ${esc(r.checkName)}${clears}`;
}

async function loadRules() {
  const { rules } = await api('/events/rules');
  document.getElementById('rules-empty').hidden = rules.length > 0;
  rulesEl.innerHTML = rules.map((r) => `
    <tr style="${r.enabled ? '' : 'opacity:.5'}">
      <td class="num">${r.priority}</td>
      <td>${esc(r.name)}${r.enabled ? '' : ' <span class="sub">(off)</span>'}</td>
      <td>${selects(r)}</td>
      <td>${does(r)}</td>
    </tr>`).join('');
}

/* ── the dry run ───────────────────────────────────────────────────────── */

const dialog = document.getElementById('test-dialog');
document.getElementById('open-test').addEventListener('click', () => dialog.showModal());

document.getElementById('t-run').addEventListener('click', async (ev) => {
  ev.preventDefault();
  const severity = document.getElementById('t-severity').value;
  const body = {
    source: document.getElementById('t-source').value,
    oid: document.getElementById('t-oid').value.trim(),
    appName: document.getElementById('t-app').value.trim(),
    message: document.getElementById('t-message').value,
    severity: severity === '' ? null : Number(severity),
  };
  const out = document.getElementById('t-result');
  try {
    const { decision } = await api('/events/test', { method: 'POST', body });
    const verdict = decision.action === 'alert'
      ? `<span class="chip ${esc(decision.severity)}">raises ${esc(decision.severity)}</span>`
      : `<span class="chip info">${esc(decision.action)}</span>`;
    out.innerHTML = `
      ${verdict}
      <div style="margin-top:8px">Alert would be <strong>${esc(decision.checkName)}</strong></div>
      <div class="sub" style="margin-top:4px">
        ${decision.ruleName
          ? `matched by “${esc(decision.ruleName)}”`
          : 'no rule matched — logged only'}
        ${decision.autoClearSeconds ? ` · closes itself after ${decision.autoClearSeconds}s` : ''}
      </div>`;
  } catch (err) {
    out.textContent = `Could not evaluate: ${err.message}`;
  }
});

/* ── wiring ────────────────────────────────────────────────────────────── */

let debounce;
for (const id of ['f-source', 'f-action', 'f-severity', 'f-device', 'f-q']) {
  const el = document.getElementById(id);
  const handler = () => { clearTimeout(debounce); debounce = setTimeout(loadEvents, 250); };
  el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', handler);
}

async function refresh() {
  try {
    await Promise.all([loadEvents(), loadSenders(), loadRules()]);
  } catch (err) {
    toast(`Could not load events: ${err.message}`, 'error');
  }
}

await refresh();
// Events arrive between polls by definition, so the page refreshes itself.
setInterval(() => loadEvents().catch(() => {}), 15_000);
