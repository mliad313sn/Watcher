import '@watcher/ui';
import { escapeHtml as esc } from '@watcher/ui';
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
    await api(`/oncall/schedules/${b.dataset.delSched}`, { method: 'DELETE' }).catch(() => {});
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
    await api(`/runbooks/${b.dataset.delRb}`, { method: 'DELETE' }).catch(() => {});
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
    await api(`/status/components/${b.dataset.delSc}`, { method: 'DELETE' }).catch(() => {});
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
