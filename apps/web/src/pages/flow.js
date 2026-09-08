import '@watcher/ui';
import { escapeHtml as esc, toast } from '@watcher/ui';
import { api, requireAuth } from '../lib/api.js';

requireAuth();

/**
 * Bytes as an operator reads them. Flow totals span from a few kilobytes to
 * tens of terabytes in the same table, so a fixed unit makes one end of the
 * range unreadable.
 */
function bytes(n) {
  const value = Number(n ?? 0);
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = value;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const count = (n) => Number(n ?? 0).toLocaleString();
const hours = () => document.getElementById('f-hours').value;

async function loadTalkers() {
  const { talkers } = await api(`/flow/talkers?hours=${hours()}&limit=10`);
  document.getElementById('talkers').innerHTML = talkers.map((t) => `
    <tr><td><code>${esc(t.addr)}</code></td>
        <td class="num">${bytes(t.bytes)}</td>
        <td class="num">${count(t.packets)}</td></tr>`).join('');
  return talkers.length;
}

async function loadServices() {
  const { services } = await api(`/flow/services?hours=${hours()}&limit=10`);
  const total = services.reduce((n, s) => n + Number(s.bytes), 0) || 1;
  document.getElementById('services').innerHTML = services.map((s) => {
    const pct = (Number(s.bytes) / total) * 100;
    return `
    <tr><td>${esc(s.service)}</td>
        <td class="num">${bytes(s.bytes)}</td>
        <td><div style="background:var(--bg-high);border-radius:3px;height:8px;width:100%">
              <div style="background:var(--accent);height:8px;border-radius:3px;width:${pct.toFixed(1)}%"></div>
            </div></td></tr>`;
  }).join('');
}

async function loadInterfaces() {
  const { interfaces } = await api(`/flow/interfaces?hours=${hours()}&limit=10`);
  document.getElementById('interfaces').innerHTML = interfaces.map((i) => `
    <tr><td>${i.device_id
          ? `<a href="/device.html?id=${esc(i.device_id)}">${esc(i.device_name ?? i.device_id)}</a>`
          : '<span class="sub">unknown exporter</span>'}</td>
        <td class="num">${i.if_index}</td>
        <td class="num">${bytes(i.bytes)}</td>
        <td class="num">${count(i.conversations)}</td></tr>`).join('');
}

async function loadConversations() {
  const { conversations } = await api(`/flow/conversations?hours=${hours()}&limit=50`);
  document.getElementById('conversations').innerHTML = conversations.map((c) => `
    <tr><td><code>${esc(c.src)}</code></td>
        <td><code>${esc(c.dst)}</code></td>
        <td>${esc(c.service)}</td>
        <td class="num">${bytes(c.bytes)}</td>
        <td class="num">${count(c.packets)}</td></tr>`).join('');
  return conversations.length;
}

async function refresh() {
  try {
    const [talkers, conversations] = await Promise.all([
      loadTalkers(), loadConversations(), loadServices(), loadInterfaces(),
    ]);
    document.getElementById('empty').hidden = talkers > 0 || conversations > 0;
  } catch (err) {
    toast(`Could not load traffic: ${err.message}`, 'error');
  }
}

document.getElementById('f-hours').addEventListener('change', refresh);
await refresh();
// The collector flushes on an interval, so anything faster shows the same rows.
setInterval(() => refresh().catch(() => {}), 60_000);
