import '@watcher/ui';
import { escapeHtml as esc } from '@watcher/ui';

// Public status board — no authentication. Reads the sanitized public endpoint.

const board = document.getElementById('board');
const tenant = new URLSearchParams(location.search).get('tenant') ?? 'default';

const LABEL = {
  operational: 'All Systems Operational',
  degraded: 'Partial Service Degradation',
  major_outage: 'Major Outage',
};
const COMP_LABEL = { operational: 'Operational', degraded: 'Degraded', major_outage: 'Major outage' };

async function load() {
  let data;
  try {
    const res = await fetch(`/api/status/public?tenant=${encodeURIComponent(tenant)}`);
    if (!res.ok) throw new Error();
    data = await res.json();
  } catch {
    board.innerHTML = '<div class="dim" style="text-align:center;padding:30px">Status is temporarily unavailable.</div>';
    return;
  }

  if (data.components.length === 0) {
    board.innerHTML = `
      <div class="overall operational"><div class="big">${LABEL.operational}</div></div>
      <div class="status-foot">No components are published on this status page yet.</div>`;
    return;
  }

  board.innerHTML = `
    <div class="overall ${data.overall}">
      <div class="big">${LABEL[data.overall] ?? 'Status'}</div>
    </div>
    <div class="components">
      ${data.components.map((c) => `
        <div class="comp">
          <div>
            <div class="nm">${esc(c.name)}</div>
            <div class="sub">${c.devices} monitored${c.impacted ? ` · ${c.impacted} impacted` : ''}</div>
          </div>
          <span class="st ${c.status}"><span class="dot"></span>${COMP_LABEL[c.status] ?? c.status}</span>
        </div>`).join('')}
    </div>
    <div class="status-foot">Updated ${new Date(data.generatedAt).toLocaleString()} · refreshes every 30s</div>`;
}

await load();
setInterval(() => load().catch(() => {}), 30_000);
