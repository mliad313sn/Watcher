import '@watcher/ui';
import { escapeHtml as esc } from '@watcher/ui';

// Standalone one-tap acknowledge page — reached from a link in a notification,
// authenticated by the token in the URL (no console login). Mobile-first.

const token = new URLSearchParams(location.search).get('t');
const body = document.getElementById('body');

const SEV_CLASS = { critical: 'critical', warning: 'warning', info: 'info' };
const STATE_LABEL = {
  acknowledged: 'This alert is already acknowledged.',
  resolved: 'This alert has already resolved.',
};

function fail(msg) {
  body.className = 'center';
  body.innerHTML = `
    <span class="material-symbols-outlined" style="font-size:40px;color:var(--warning)">link_off</span>
    <div style="margin-top:10px;color:var(--text)">${esc(msg)}</div>`;
}

function acknowledgedView(device, check) {
  body.className = '';
  body.innerHTML = `
    <div class="done">
      <span class="material-symbols-outlined" style="color:var(--ok)">task_alt</span>
      <h1 style="margin-top:8px">Acknowledged</h1>
      <p class="sub">You're now the owner of this incident. Escalation has stopped.</p>
      <div class="obj" style="margin-top:10px">${esc(device)}${check ? ' / ' + esc(check) : ''}</div>
    </div>`;
}

async function load() {
  if (!token) return fail('This acknowledge link is missing its token.');
  let alert;
  try {
    const res = await fetch(`/api/alerts/ack-info?token=${encodeURIComponent(token)}`);
    if (res.status === 401) return fail('This link is invalid or has expired.');
    if (!res.ok) return fail('That alert could not be found.');
    ({ alert } = await res.json());
  } catch {
    return fail('Could not reach Watcher. Check your connection and retry.');
  }

  if (alert.status !== 'open' && alert.status !== 'suppressed') {
    body.className = '';
    body.innerHTML = `
      <div class="done">
        <span class="material-symbols-outlined" style="color:var(--ok)">check_circle</span>
        <div style="margin-top:8px;color:var(--text)">${esc(STATE_LABEL[alert.status] ?? 'Nothing to do.')}</div>
        <div class="obj" style="margin-top:8px">${esc(alert.device_name)}${alert.check_name ? ' / ' + esc(alert.check_name) : ''}</div>
      </div>`;
    return;
  }

  const sev = SEV_CLASS[alert.severity] ?? 'info';
  body.className = '';
  body.innerHTML = `
    <h1>Acknowledge alert?</h1>
    <div class="sub">Confirm you're taking this incident. Escalation stops immediately.</div>
    <div class="meta">
      <span class="chip ${sev}">${esc(alert.severity)}</span>
      <span class="dim mono" style="font-size:11px">${new Date(alert.opened_at).toLocaleString()}</span>
    </div>
    <div class="obj">${esc(alert.device_name)}${alert.check_name ? ' / ' + esc(alert.check_name) : ''}</div>
    <div class="msg">${esc(alert.message)}</div>
    <button class="btn primary big" id="ack-btn">
      <span class="material-symbols-outlined">task_alt</span>Acknowledge
    </button>
    <div id="ack-err" style="color:var(--critical);font-size:12px;margin-top:10px;min-height:16px;text-align:center"></div>`;

  document.getElementById('ack-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = 'Acknowledging…';
    try {
      const res = await fetch('/api/alerts/ack-by-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not acknowledge');
      acknowledgedView(alert.device_name, alert.check_name);
    } catch (err) {
      document.getElementById('ack-err').textContent = err.message;
      btn.disabled = false;
      btn.innerHTML = '<span class="material-symbols-outlined">task_alt</span>Acknowledge';
    }
  });
}

load();
