import '@watcher/ui';
import { api, requireAuth, liveEvents } from '../lib/api.js';

requireAuth();

const svg = document.getElementById('map');
let hostState = new Map();
let graph = { nodes: [], links: [] };

const STATE_COLOR = ['var(--ok)', 'var(--critical)', 'var(--warning)'];

/**
 * Layered layout: roots (no parent) on top, children below their parent.
 * Discovered topology_links render as thin extra edges between layers.
 */
function layout(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depthOf = (n, seen = new Set()) => {
    if (!n.parent_id || seen.has(n.id) || !byId.has(n.parent_id)) return 0;
    seen.add(n.id);
    return 1 + depthOf(byId.get(n.parent_id), seen);
  };

  const layers = new Map();
  for (const n of nodes) {
    const d = depthOf(n);
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(n);
  }

  const width = svg.clientWidth || 1000;
  const layerH = 130;
  const pos = new Map();
  for (const [depth, layerNodes] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    layerNodes.sort((a, b) => a.name.localeCompare(b.name));
    const gap = width / (layerNodes.length + 1);
    layerNodes.forEach((n, i) => {
      pos.set(n.id, { x: gap * (i + 1), y: 70 + depth * layerH });
    });
  }
  return pos;
}

function render() {
  const pos = layout(graph.nodes);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const parentEdges = graph.nodes
    .filter((n) => n.parent_id && pos.has(n.parent_id))
    .map((n) => ({ a: pos.get(n.parent_id), b: pos.get(n.id), cls: 'parent' }));

  const discoveredEdges = graph.links
    .filter((l) => pos.has(l.a_device_id) && pos.has(l.b_device_id))
    .map((l) => ({ a: pos.get(l.a_device_id), b: pos.get(l.b_device_id), cls: 'disc' }));

  svg.innerHTML = `
    <g>
      ${[...parentEdges, ...discoveredEdges].map((e) => `
        <line x1="${e.a.x}" y1="${e.a.y}" x2="${e.b.x}" y2="${e.b.y}"
              stroke="${e.cls === 'parent' ? 'var(--border-strong)' : 'var(--accent)'}"
              stroke-width="${e.cls === 'parent' ? 2 : 1}"
              ${e.cls === 'disc' ? 'stroke-dasharray="4 3" opacity="0.5"' : ''}></line>`).join('')}
      ${graph.nodes.map((n) => {
        const p = pos.get(n.id);
        const state = hostState.get(n.name);
        const color = state ? (STATE_COLOR[state.state] ?? 'var(--unknown)') : 'var(--unknown)';
        return `
          <g style="cursor:pointer" onclick="location.href='/device.html?id=${n.id}&name=${encodeURIComponent(n.name)}'">
            <circle cx="${p.x}" cy="${p.y}" r="17" fill="var(--bg-raised)"
                    stroke="${color}" stroke-width="2.5"></circle>
            <circle cx="${p.x}" cy="${p.y}" r="5" fill="${color}"></circle>
            <text x="${p.x}" y="${p.y + 33}" text-anchor="middle" fill="var(--text-dim)"
                  font-size="11">${n.name}</text>
          </g>`;
      }).join('')}
    </g>`;
}

async function load() {
  const [g, state] = await Promise.all([
    api('/devices/topology/graph'),
    api('/nagios/state').catch(() => ({ hosts: [] })),
  ]);
  graph = g;
  hostState = new Map(state.hosts.map((h) => [h.host, h]));
  render();
}

await load();
window.addEventListener('resize', render);
liveEvents(['state'], (channel, data) => {
  if (data.kind === 'host') {
    const existing = hostState.get(data.host);
    hostState.set(data.host, { ...existing, state: data.state });
    render();
  }
});
