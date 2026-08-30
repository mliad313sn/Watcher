/**
 * Command palette — a single keyboard-driven way to reach anything.
 *
 * Enterprise operators live in the keyboard; hunting through a sidebar is slow.
 * Cmd/Ctrl-K (or "/") opens a spotlight that fuzzy-matches navigation targets
 * and live devices, and runs on Enter. Vim-style "g then <key>" jumps straight
 * to a section, and "?" shows the shortcut cheat sheet.
 *
 * Self-contained: reads the auth token from localStorage and calls the API
 * directly, so it has no dependency on the app's api helper and can live in the
 * shared chrome.
 */
import { escapeHtml } from './escape.js';

const NAV = [
  { label: 'Global View — dashboard', href: '/index.html', icon: 'language', key: 'd' },
  { label: 'Inventory — devices', href: '/devices.html', icon: 'inventory_2', key: 'i' },
  { label: 'Alerts — correlation center', href: '/alerts.html', icon: 'warning', key: 'a' },
  { label: 'Topology — network map', href: '/topology.html', icon: 'hub', key: 't' },
  { label: 'Reports — availability', href: '/reports.html', icon: 'monitoring', key: 'r' },
  { label: 'Admin — settings', href: '/settings.html', icon: 'admin_panel_settings', key: 's' },
  { label: 'Public status page', href: '/status.html', icon: 'language' },
];

const SHORTCUTS = [
  ['⌘K / Ctrl-K', 'Open command palette'],
  ['/', 'Search'],
  ['g then d', 'Go to dashboard'],
  ['g then i', 'Go to inventory'],
  ['g then a', 'Go to alerts'],
  ['g then t', 'Go to topology'],
  ['g then r', 'Go to reports'],
  ['g then s', 'Go to admin'],
  ['?', 'Show this help'],
  ['Esc', 'Close'],
];

function token() { try { return localStorage.getItem('watcher.token'); } catch { return null; } }

// Cheap subsequence fuzzy match + score (lower = better).
function fuzzy(needle, hay) {
  needle = needle.toLowerCase(); hay = hay.toLowerCase();
  if (!needle) return 0;
  let i = 0, score = 0, last = -1;
  for (const ch of needle) {
    const idx = hay.indexOf(ch, last + 1);
    if (idx === -1) return Infinity;
    score += idx - last; last = idx;
  }
  return score + hay.length * 0.01;
}

let el, input, listEl, items = [], active = 0, devices = [], open = false;

function ensureDom() {
  if (el) return;
  el = document.createElement('div');
  el.id = 'w-palette';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Command palette');
  el.innerHTML = `
    <div class="w-pal-backdrop"></div>
    <div class="w-pal-box" role="combobox" aria-expanded="true" aria-haspopup="listbox">
      <div class="w-pal-input">
        <span class="material-symbols-outlined">search</span>
        <input type="text" autocomplete="off" spellcheck="false"
               placeholder="Jump to a page or device…  (try a device name)" aria-label="Command palette search" />
        <kbd>esc</kbd>
      </div>
      <div class="w-pal-list" role="listbox"></div>
      <div class="w-pal-foot mono">
        <span><kbd>↑↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>?</kbd> shortcuts</span>
      </div>
    </div>`;
  document.body.appendChild(el);
  input = el.querySelector('input');
  listEl = el.querySelector('.w-pal-list');

  el.querySelector('.w-pal-backdrop').addEventListener('click', close);
  input.addEventListener('input', () => {
    rebuild(input.value);                 // instant re-rank of what we have
    clearTimeout(debounce);               // + debounced live device search
    const q = input.value;
    debounce = setTimeout(async () => {
      if (!open) return;
      devices = await loadDevices(q);
      rebuild(input.value);
    }, 180);
  });
  input.addEventListener('keydown', onKey);
  injectStyles();
}

async function loadDevices(q) {
  const t = token();
  if (!t) return [];
  try {
    const res = await fetch(`/api/devices?limit=8${q ? '&q=' + encodeURIComponent(q) : ''}`,
      { headers: { Authorization: `Bearer ${t}` } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.devices ?? data ?? []).map((d) => ({
      label: d.name, sub: d.kind, href: `/device.html?id=${d.id}`, icon: 'lan', device: true,
    }));
  } catch { return []; }
}

function rebuild(q) {
  const navMatches = NAV
    .map((n) => ({ ...n, score: fuzzy(q, n.label) }))
    .filter((n) => n.score !== Infinity)
    .sort((a, b) => a.score - b.score);
  const devMatches = devices
    .map((d) => ({ ...d, score: fuzzy(q, d.label) }))
    .filter((d) => d.score !== Infinity)
    .sort((a, b) => a.score - b.score);
  items = [...navMatches, ...devMatches].slice(0, 12);
  active = 0;
  renderList();
}

function renderList() {
  if (items.length === 0) {
    listEl.innerHTML = '<div class="w-pal-empty">No matches</div>';
    return;
  }
  listEl.innerHTML = items.map((it, i) => `
    <div class="w-pal-item ${i === active ? 'active' : ''}" role="option" aria-selected="${i === active}" data-i="${i}">
      <span class="material-symbols-outlined">${it.icon ?? 'chevron_right'}</span>
      <span class="w-pal-label">${escapeHtml(it.label)}${it.sub ? `<span class="w-pal-sub">${escapeHtml(it.sub)}</span>` : ''}</span>
      ${it.key ? `<kbd>g ${it.key}</kbd>` : it.device ? '<kbd>device</kbd>' : ''}
    </div>`).join('');
  listEl.querySelectorAll('.w-pal-item').forEach((row) => {
    row.addEventListener('click', () => { active = Number(row.dataset.i); run(); });
    row.addEventListener('mousemove', () => { if (active !== Number(row.dataset.i)) { active = Number(row.dataset.i); renderList(); } });
  });
  const activeEl = listEl.querySelector('.w-pal-item.active');
  activeEl?.scrollIntoView({ block: 'nearest' });
}

function onKey(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); renderList(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); renderList(); }
  else if (e.key === 'Enter') { e.preventDefault(); run(); }
  else if (e.key === 'Escape') { e.preventDefault(); close(); }
}

function run() {
  const it = items[active];
  if (it?.href) { close(); location.href = it.href; }
}

let debounce;
export function openPalette() {
  ensureDom();
  el.hidden = false; open = true;
  input.value = ''; devices = [];
  rebuild('');
  input.focus();
  // Warm the first page of devices immediately so they're offered before typing.
  loadDevices('').then((d) => { if (open) { devices = d; rebuild(input.value); } });
}

export function close() {
  if (el) { el.hidden = true; }
  open = false;
}

// ── Global key handling: palette open, "/", "g <key>", "?" ──────────────────
let gPending = 0;
function isTyping(t) {
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export function installShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Cmd/Ctrl-K always opens, even from a field.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault(); open ? close() : openPalette(); return;
    }
    if (open) return; // palette handles its own keys
    if (isTyping(e.target)) return;

    if (e.key === '/') { e.preventDefault(); openPalette(); return; }
    if (e.key === '?') { e.preventDefault(); toggleHelp(); return; }

    const now = Date.now();
    if (e.key === 'g') { gPending = now; return; }
    if (gPending && now - gPending < 1200) {
      const nav = NAV.find((n) => n.key === e.key.toLowerCase());
      gPending = 0;
      if (nav) { e.preventDefault(); location.href = nav.href; }
    }
  });
}

// ── Shortcut cheat sheet ("?") ──────────────────────────────────────────────
let helpEl;
function toggleHelp() {
  if (helpEl && !helpEl.hidden) { helpEl.hidden = true; return; }
  if (!helpEl) {
    helpEl = document.createElement('div');
    helpEl.id = 'w-help';
    helpEl.setAttribute('role', 'dialog');
    helpEl.setAttribute('aria-label', 'Keyboard shortcuts');
    helpEl.innerHTML = `
      <div class="w-pal-backdrop"></div>
      <div class="w-help-box">
        <h3>Keyboard shortcuts</h3>
        <table>${SHORTCUTS.map(([k, d]) => `<tr><td><kbd>${escapeHtml(k)}</kbd></td><td>${escapeHtml(d)}</td></tr>`).join('')}</table>
        <div class="w-help-foot mono">press <kbd>?</kbd> or <kbd>esc</kbd> to close</div>
      </div>`;
    document.body.appendChild(helpEl);
    helpEl.querySelector('.w-pal-backdrop').addEventListener('click', () => { helpEl.hidden = true; });
    document.addEventListener('keydown', (e) => { if (!helpEl.hidden && e.key === 'Escape') helpEl.hidden = true; });
    injectStyles();
  }
  helpEl.hidden = false;
}

function injectStyles() {
  if (document.getElementById('w-pal-css')) return;
  const s = document.createElement('style');
  s.id = 'w-pal-css';
  s.textContent = `
    #w-palette, #w-help { position: fixed; inset: 0; z-index: 900; display: flex;
      align-items: flex-start; justify-content: center; }
    .w-pal-backdrop { position: absolute; inset: 0; background: rgba(4,6,10,.62); backdrop-filter: blur(2px); }
    .w-pal-box { position: relative; margin-top: 12vh; width: min(92vw, 560px);
      background: var(--bg-raised, #12151d); border: 1px solid var(--border-strong, #2a2e39);
      border-radius: 10px; box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden;
      animation: w-pal-in .12s ease-out; }
    @keyframes w-pal-in { from { opacity: 0; transform: translateY(-6px) scale(.99); } to { opacity: 1; transform: none; } }
    .w-pal-input { display: flex; align-items: center; gap: 10px; padding: 12px 14px;
      border-bottom: 1px solid var(--border, #21242e); }
    .w-pal-input .material-symbols-outlined { color: var(--text-faint, #7c8190); font-size: 20px; }
    .w-pal-input input { flex: 1; background: none; border: none; outline: none;
      color: var(--text-head, #e8eaf0); font-size: 15px; }
    .w-pal-input kbd, .w-pal-foot kbd, .w-pal-item kbd, .w-help-box kbd { font-family: var(--mono, monospace);
      font-size: 11px; color: var(--text-dim, #a4a9b6); background: var(--bg-high, #1b1f29);
      border: 1px solid var(--border, #21242e); border-radius: 4px; padding: 1px 5px; }
    .w-pal-list { max-height: 46vh; overflow: auto; padding: 6px; }
    .w-pal-item { display: flex; align-items: center; gap: 11px; padding: 9px 10px;
      border-radius: 6px; cursor: pointer; color: var(--text, #c8ccd6); }
    .w-pal-item.active { background: var(--accent-soft, rgba(76,141,255,.14)); color: var(--text-head, #e8eaf0); }
    .w-pal-item .material-symbols-outlined { font-size: 19px; color: var(--text-faint, #7c8190); }
    .w-pal-item.active .material-symbols-outlined { color: var(--accent, #4c8dff); }
    .w-pal-label { flex: 1; font-size: 14px; display: flex; align-items: baseline; gap: 8px; }
    .w-pal-sub { font-size: 11px; color: var(--text-faint, #7c8190); font-family: var(--mono, monospace); }
    .w-pal-empty { padding: 22px; text-align: center; color: var(--text-faint, #7c8190); font-size: 13px; }
    .w-pal-foot { display: flex; gap: 16px; padding: 8px 14px; border-top: 1px solid var(--border, #21242e);
      font-size: 11px; color: var(--text-faint, #7c8190); }
    .w-help-box { position: relative; margin-top: 16vh; width: min(92vw, 420px);
      background: var(--bg-raised, #12151d); border: 1px solid var(--border-strong, #2a2e39);
      border-radius: 10px; padding: 20px 22px; box-shadow: 0 24px 70px rgba(0,0,0,.55); }
    .w-help-box h3 { margin: 0 0 14px; font-size: 15px; color: var(--text-head, #e8eaf0); }
    .w-help-box table { width: 100%; border-collapse: collapse; }
    .w-help-box td { padding: 5px 0; font-size: 13px; color: var(--text, #c8ccd6); }
    .w-help-box td:first-child { width: 130px; }
    .w-help-foot { margin-top: 14px; font-size: 11px; color: var(--text-faint, #7c8190); }
  `;
  document.head.appendChild(s);
}
