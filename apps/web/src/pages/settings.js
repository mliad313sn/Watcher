import '@watcher/ui';
import { escapeHtml as esc, toast } from '@watcher/ui';
import { api, requireAuth } from '../lib/api.js';

requireAuth();

document.getElementById('user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('u-msg');
  try {
    await api('/auth/users', {
      method: 'POST',
      body: {
        username: document.getElementById('u-name').value,
        password: document.getElementById('u-pass').value,
        role: document.getElementById('u-role').value,
      },
    });
    msg.style.color = 'var(--ok)';
    msg.textContent = 'User created.';
    e.target.reset();
  } catch (err) {
    msg.style.color = 'var(--critical)';
    msg.textContent = err.message;
  }
});

async function loadJobs() {
  const { jobs } = await api('/discovery/jobs');
  document.getElementById('jobs').innerHTML = jobs.map((j) => `
    <tr>
      <td class="mono">${j.cidr}</td>
      <td><span class="chip ${j.status === 'done' ? 'ok' : j.status === 'failed' ? 'critical' : j.status === 'running' ? 'info' : 'unknown'}">${j.status}</span></td>
      <td class="dim">${j.last_run_at ? new Date(j.last_run_at).toLocaleString() : '—'}</td>
      <td class="dim mono" style="font-size:11px">${j.result?.found !== undefined ? `${j.result.found}/${j.result.scanned} found` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="empty">No discovery jobs yet.</td></tr>';
}

document.getElementById('disc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('d-msg');
  try {
    await api('/discovery/jobs', {
      method: 'POST',
      body: { cidr: document.getElementById('d-cidr').value },
    });
    msg.style.color = 'var(--ok)';
    msg.textContent = 'Discovery queued.';
    loadJobs();
  } catch (err) {
    msg.style.color = 'var(--critical)';
    msg.textContent = err.message;
  }
});

await loadJobs();
setInterval(loadJobs, 10_000);

// ── On-call schedules ──────────────────────────────────────────────────────
const ocList = document.getElementById('oncall-list');

function untilHandoff(ms) {
  const s = Math.max(0, (ms - Date.now()) / 1000);
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

async function loadOncall() {
  let schedules = [];
  try { ({ schedules } = await api('/oncall/schedules')); } catch { return; }
  if (schedules.length === 0) {
    ocList.innerHTML = '<div class="dim" style="font-size:13px">No rotations yet — create one below, or load the demo environment.</div>';
    return;
  }
  ocList.innerHTML = schedules.map((s) => {
    const on = s.current?.onCall;
    const source = s.current?.source;
    const roster = s.participants.map((p, i) =>
      `<span class="chip ${on && p.name === on.name ? 'ok' : 'unknown'}" style="margin:0 4px 4px 0">${i + 1}. ${esc(p.name)}</span>`).join('');
    return `
      <div style="border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;margin-bottom:10px">
        <div class="row" style="justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-weight:600">${esc(s.name)}</div>
            <div class="dim mono" style="font-size:11px;margin-top:2px">rotation every ${Math.round(s.rotation_interval_s / 86400)}d</div>
          </div>
          <div style="text-align:right">
            <div class="label-caps" style="font-size:10px">On call now</div>
            <div style="font-weight:700;color:var(--accent-text);font-size:16px">${on ? esc(on.name) : '—'}</div>
            ${on && s.current.nextHandoffMs ? `<div class="dim mono" style="font-size:11px">${source === 'override' ? 'cover ends' : 'handoff'} in ${untilHandoff(s.current.nextHandoffMs)}</div>` : ''}
          </div>
        </div>
        <div style="margin-top:12px">${roster}</div>
        <div style="margin-top:8px"><button class="btn danger" data-del-sched="${esc(s.id)}" style="font-size:11px;padding:3px 10px">Delete</button></div>
      </div>`;
  }).join('');

  ocList.querySelectorAll('[data-del-sched]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this on-call rotation?')) return;
    try { await api(`/oncall/schedules/${b.dataset.delSched}`, { method: 'DELETE' }); toast('Rotation deleted', { type: 'success' }); }
    catch (err) { toast(`Could not delete: ${err.message}`, { type: 'error' }); }
    loadOncall();
  }));
}

document.getElementById('oncall-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('oc-msg');
  const people = document.getElementById('oc-people').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (people.length === 0) { msg.style.color = 'var(--critical)'; msg.textContent = 'Add at least one responder.'; return; }
  try {
    await api('/oncall/schedules', {
      method: 'POST',
      body: {
        name: document.getElementById('oc-name').value,
        rotationIntervalS: Number(document.getElementById('oc-interval').value),
        // Contacts default to the log channel; wire real webhook/email later.
        participants: people.map((name) => ({ name, contact: { type: 'log' } })),
      },
    });
    msg.style.color = 'var(--ok)';
    msg.textContent = 'Rotation created.';
    e.target.reset();
    loadOncall();
  } catch (err) {
    msg.style.color = 'var(--critical)';
    msg.textContent = err.message;
  }
});

await loadOncall();
setInterval(loadOncall, 30_000);

// ── Runbooks ────────────────────────────────────────────────────────────────
const rbList = document.getElementById('rb-list');

function describeMatch(m) {
  const bits = [];
  if (m.kind) bits.push(`kind=${m.kind}`);
  if (m.checkPattern) bits.push(`check~/${m.checkPattern}/`);
  if (m.devicePattern) bits.push(`device~/${m.devicePattern}/`);
  if (m.minSeverity) bits.push(`≥${m.minSeverity}`);
  if (m.tags) bits.push(...Object.entries(m.tags).map(([k, v]) => `${k}=${v}`));
  return bits.length ? bits.join(' · ') : 'any alert';
}

async function loadRunbooks() {
  let runbooks = [];
  try { ({ runbooks } = await api('/runbooks')); } catch { return; }
  if (runbooks.length === 0) {
    rbList.innerHTML = '<div class="dim" style="font-size:13px">No runbooks yet — add one below, or load the demo environment.</div>';
    return;
  }
  rbList.innerHTML = runbooks.map((r) => `
    <div style="border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px;margin-bottom:8px">
      <div class="row" style="justify-content:space-between">
        <div>
          <span class="material-symbols-outlined" style="color:var(--accent);font-size:16px;vertical-align:-3px">menu_book</span>
          <strong>${esc(r.name)}</strong>
          <span class="dim mono" style="font-size:11px;margin-left:8px">${esc(describeMatch(r.match || {}))}</span>
        </div>
        <button class="btn danger" data-del-rb="${esc(r.id)}" style="font-size:11px;padding:3px 10px">Delete</button>
      </div>
    </div>`).join('');
  rbList.querySelectorAll('[data-del-rb]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this runbook?')) return;
    try { await api(`/runbooks/${b.dataset.delRb}`, { method: 'DELETE' }); toast('Runbook deleted', { type: 'success' }); }
    catch (err) { toast(`Could not delete: ${err.message}`, { type: 'error' }); }
    loadRunbooks();
  }));
}

document.getElementById('rb-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('rb-msg');
  const match = {};
  const kind = document.getElementById('rb-kind').value;
  const check = document.getElementById('rb-check').value.trim();
  const sev = document.getElementById('rb-sev').value;
  if (kind) match.kind = kind;
  if (check) match.checkPattern = check;
  if (sev) match.minSeverity = sev;
  const links = document.getElementById('rb-links').value.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => { const [label, url] = l.split('|').map((s) => s.trim()); return { label: label || url, url: url || label }; })
    .filter((l) => l.url);
  try {
    await api('/runbooks', {
      method: 'POST',
      body: { name: document.getElementById('rb-name').value, match, steps: document.getElementById('rb-steps').value, links },
    });
    msg.style.color = 'var(--ok)';
    msg.textContent = 'Runbook created.';
    e.target.reset();
    loadRunbooks();
  } catch (err) {
    msg.style.color = 'var(--critical)';
    msg.textContent = err.message;
  }
});

await loadRunbooks();

// ── API tokens ──────────────────────────────────────────────────────────────
const tokList = document.getElementById('tok-list');

async function loadTokens() {
  let tokens = [];
  try { ({ tokens } = await api('/auth/tokens')); } catch { tokList.innerHTML = ''; return; }
  if (tokens.length === 0) {
    tokList.innerHTML = '<div class="dim" style="font-size:13px">No tokens yet.</div>';
    return;
  }
  tokList.innerHTML = tokens.map((t) => `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;
         border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;margin-bottom:8px">
      <div>
        <strong class="mono">${esc(t.name)}</strong>
        <span class="chip ${t.role === 'admin' ? 'critical' : t.role === 'operator' ? 'warning' : 'unknown'}" style="margin-left:8px">${t.role}</span>
        <div class="dim mono" style="font-size:11px;margin-top:3px">
          ${t.last_used_at ? 'last used ' + new Date(t.last_used_at).toLocaleString() : 'never used'}
          · ${t.expires_at ? 'expires ' + new Date(t.expires_at).toLocaleDateString() : 'no expiry'}</div>
      </div>
      <button class="btn danger" data-del-tok="${esc(t.id)}" style="font-size:11px;padding:3px 10px">Revoke</button>
    </div>`).join('');
  tokList.querySelectorAll('[data-del-tok]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Revoke this token? Anything using it stops working immediately.')) return;
    try { await api(`/auth/tokens/${b.dataset.delTok}`, { method: 'DELETE' }); toast('Token revoked', { type: 'success' }); }
    catch (err) { toast(`Could not revoke: ${err.message}`, { type: 'error' }); }
    loadTokens();
  }));
}

document.getElementById('tok-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('tok-msg');
  const secretEl = document.getElementById('tok-secret');
  const exp = document.getElementById('tok-exp').value;
  try {
    const { secret } = await api('/auth/tokens', {
      method: 'POST',
      body: {
        name: document.getElementById('tok-name').value,
        role: document.getElementById('tok-role').value,
        ...(exp ? { expiresInDays: Number(exp) } : {}),
      },
    });
    msg.style.color = 'var(--ok)';
    msg.textContent = 'Token created — copy the secret now, it will not be shown again:';
    secretEl.hidden = false;
    secretEl.textContent = secret;
    e.target.reset();
    loadTokens();
  } catch (err) {
    msg.style.color = 'var(--critical)';
    msg.textContent = err.message;
  }
});

await loadTokens();

// ── Maintenance windows ─────────────────────────────────────────────────────
const mwList = document.getElementById('mw-list');

async function loadWindows() {
  let windows = [];
  try { ({ windows } = await api('/maintenance')); } catch { return; }
  if (windows.length === 0) {
    mwList.innerHTML = '<div class="dim" style="font-size:13px">Nothing scheduled.</div>';
    return;
  }
  mwList.innerHTML = windows.map((w) => {
    const scope = [w.match?.kind && `kind=${w.match.kind}`, w.match?.devicePattern && `name~/${w.match.devicePattern}/`]
      .filter(Boolean).join(' · ') || 'all devices';
    return `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;
         border:1px solid var(--border);border-radius:var(--radius);padding:11px 14px;margin-bottom:8px">
      <div>
        ${w.active ? '<span class="chip info" style="margin-right:8px">ACTIVE NOW</span>' : ''}
        <strong>${esc(w.name)}</strong>
        <span class="dim mono" style="font-size:11px;margin-left:8px">${esc(scope)}</span>
        <div class="dim mono" style="font-size:11px;margin-top:3px">
          ${new Date(w.starts_at).toLocaleString()} → ${new Date(w.ends_at).toLocaleString()}</div>
      </div>
      <button class="btn danger" data-del-mw="${esc(w.id)}" style="font-size:11px;padding:3px 10px">Cancel</button>
    </div>`;
  }).join('');
  mwList.querySelectorAll('[data-del-mw]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Cancel this maintenance window?')) return;
    try { await api(`/maintenance/${b.dataset.delMw}`, { method: 'DELETE' }); toast('Window cancelled', { type: 'success' }); }
    catch (err) { toast(`Could not cancel: ${err.message}`, { type: 'error' }); }
    loadWindows();
  }));
}

document.getElementById('mw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('mw-msg');
  const match = {};
  const kind = document.getElementById('mw-kind').value;
  const pattern = document.getElementById('mw-pattern').value.trim();
  if (kind) match.kind = kind;
  if (pattern) match.devicePattern = pattern;
  try {
    await api('/maintenance', {
      method: 'POST',
      body: {
        name: document.getElementById('mw-name').value,
        startsAt: new Date(document.getElementById('mw-start').value).toISOString(),
        endsAt: new Date(document.getElementById('mw-end').value).toISOString(),
        match,
      },
    });
    msg.style.color = 'var(--ok)';
    msg.textContent = 'Maintenance scheduled.';
    e.target.reset();
    loadWindows();
  } catch (err) {
    msg.style.color = 'var(--critical)';
    msg.textContent = err.message;
  }
});

await loadWindows();

// ── Public status components ────────────────────────────────────────────────
const scList = document.getElementById('sc-list');

async function loadComponents() {
  let components = [];
  try { ({ components } = await api('/status/components')); } catch { return; }
  if (components.length === 0) {
    scList.innerHTML = '<div class="dim" style="font-size:13px">No components yet — add one below, or load the demo environment.</div>';
    return;
  }
  scList.innerHTML = components.map((c) => `
    <div style="display:flex;align-items:center;justify-content:space-between;border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;margin-bottom:8px">
      <div><strong>${esc(c.name)}</strong>
        <span class="dim mono" style="font-size:11px;margin-left:8px">${esc(c.match?.kind ? 'kind=' + c.match.kind : 'custom match')}</span></div>
      <button class="btn danger" data-del-sc="${esc(c.id)}" style="font-size:11px;padding:3px 10px">Remove</button>
    </div>`).join('');
  scList.querySelectorAll('[data-del-sc]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Remove this component?')) return;
    try { await api(`/status/components/${b.dataset.delSc}`, { method: 'DELETE' }); toast('Component removed', { type: 'success' }); }
    catch (err) { toast(`Could not remove: ${err.message}`, { type: 'error' }); }
    loadComponents();
  }));
}

document.getElementById('sc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('sc-msg');
  const kind = document.getElementById('sc-kind').value;
  try {
    await api('/status/components', {
      method: 'POST',
      body: { name: document.getElementById('sc-name').value, match: kind ? { kind } : {} },
    });
    msg.style.color = 'var(--ok)';
    msg.textContent = 'Component added.';
    e.target.reset();
    loadComponents();
  } catch (err) {
    msg.style.color = 'var(--critical)';
    msg.textContent = err.message;
  }
});

await loadComponents();
