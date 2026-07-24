import '@watcher/ui';
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
