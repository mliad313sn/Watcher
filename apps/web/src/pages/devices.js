import '@watcher/ui';
import { api, requireAuth, chipClassFor } from '../lib/api.js';

requireAuth();

const tbody = document.querySelector('#table tbody');
const emptyEl = document.getElementById('empty');
let hostState = new Map();

function esc(s) {
  return String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function load() {
  const q = document.getElementById('search').value.trim();
  const kind = document.getElementById('kind').value;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (kind) params.set('kind', kind);

  const { devices } = await api(`/devices?${params}`);
  document.getElementById('count').textContent = `${devices.length} devices`;
  emptyEl.hidden = devices.length > 0;

  tbody.innerHTML = devices.map((d) => {
    const state = hostState.get(d.name);
    const chip = state
      ? `<span class="chip ${chipClassFor(state)}">${['UP', 'DOWN', 'UNREACHABLE'][state.state] ?? '?'}</span>`
      : '<span class="chip unknown">unmonitored</span>';
    return `
      <tr onclick="location.href='/device.html?id=${d.id}&name=${encodeURIComponent(d.name)}'" style="cursor:pointer">
        <td><strong>${esc(d.name)}</strong></td>
        <td class="mono">${esc(d.address ?? '')}</td>
        <td>${esc(d.kind)}</td>
        <td class="dim">${esc([d.vendor, d.model].filter(Boolean).join(' '))}</td>
        <td class="dim">${esc(d.location ?? '')}</td>
        <td>${chip}</td>
      </tr>`;
  }).join('');
}

async function loadState() {
  try {
    const { hosts } = await api('/nagios/state');
    hostState = new Map(hosts.map((h) => [h.host, h]));
  } catch { /* engine may be starting */ }
}

document.getElementById('search').addEventListener('input', debounce(load, 300));
document.getElementById('kind').addEventListener('change', load);
document.getElementById('add').addEventListener('click', async () => {
  const name = prompt('Device name (must match Nagios host_name):');
  if (!name) return;
  const address = prompt('IP address:') ?? undefined;
  await api('/devices', { method: 'POST', body: { name, address } });
  load();
});

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

await loadState();
await load();
