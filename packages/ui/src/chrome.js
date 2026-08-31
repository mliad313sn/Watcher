/**
 * <w-shell> — shared application chrome for every page of the MPA, following
 * the Aura Enterprise Monitor charter: 48px topbar (brand, centered search,
 * live status pill, icon actions) and a 240px multi-level sidebar with
 * Material Symbols icons, 2px left-border active states and an alert badge.
 *
 * Usage (in each page):
 *   <w-shell active="alerts" title="Alerts"> ...page content... </w-shell>
 */
import { escapeHtml, escapeAttr } from './escape.js';
import { openPalette, installShortcuts } from './palette.js';
import { effectiveTheme, toggleTheme } from './theme.js';

const NAV = [
  { id: 'dashboard', href: '/index.html', label: 'Global View', icon: 'language' },
  { id: 'devices', href: '/devices.html', label: 'Inventory', icon: 'inventory_2' },
  { id: 'alerts', href: '/alerts.html', label: 'Alerts', icon: 'warning', badge: true },
  { id: 'topology', href: '/topology.html', label: 'Topology', icon: 'hub' },
  { id: 'reports', href: '/reports.html', label: 'Reports', icon: 'monitoring' },
  { id: 'settings', href: '/settings.html', label: 'Admin', icon: 'admin_panel_settings' },
];

export class WShell extends HTMLElement {
  connectedCallback() {
    const active = this.getAttribute('active') ?? '';
    const title = this.getAttribute('title') ?? 'Watcher';
    const content = this.innerHTML;
    const user = JSON.parse(localStorage.getItem('watcher.user') ?? 'null');

    this.innerHTML = `
      <div class="shell">
        <a href="#w-main" class="w-skip">Skip to main content</a>
        <aside class="w-sidebar">
          <div class="w-brand">
            <div class="w-brand-mark">
              <span class="material-symbols-outlined" style="color:var(--accent)">shield</span>
            </div>
            <div>
              <div class="w-brand-name">Watcher</div>
              <span class="w-brand-ver mono">v1.0.0-rc.1</span>
            </div>
          </div>
          <nav>
            ${NAV.map((n) => `
              <a href="${n.href}" class="${n.id === active ? 'active' : ''}">
                <span class="material-symbols-outlined">${n.icon}</span>
                <span>${n.label}</span>
                ${n.badge ? '<span class="w-badge mono" id="w-alert-badge" hidden></span>' : ''}
              </a>`).join('')}
          </nav>
          <div class="w-sidebar-foot">
            <a href="#" id="w-logout">
              <span class="material-symbols-outlined">logout</span>
              <span>Sign out${user ? ` · ${escapeHtml(user.displayName ?? user.username)}` : ''}</span>
            </a>
          </div>
        </aside>
        <div class="main">
          <header class="w-topbar">
            <strong class="w-topbar-title">${escapeHtml(title)}</strong>
            <div class="grow" style="display:flex;justify-content:center">
              <button class="w-search" id="w-search-btn" type="button"
                      aria-label="Open command palette (Ctrl or Cmd + K)">
                <span class="material-symbols-outlined">search</span>
                <span class="w-search-ph">Search or jump to…</span>
                <kbd class="w-search-kbd mono">⌘K</kbd>
              </button>
            </div>
            <div class="row" style="gap:12px">
              <span class="status-pill" id="w-status-pill">
                <span class="dot"></span><span id="w-status-text">Status: —</span>
              </span>
              <div class="row" style="gap:4px" id="w-health"></div>
              <button class="w-icon-btn" id="w-theme" type="button" aria-label="Toggle light or dark theme" title="Toggle theme">
                <span class="material-symbols-outlined" aria-hidden="true">${effectiveTheme() === 'light' ? 'dark_mode' : 'light_mode'}</span>
              </button>
            </div>
          </header>
          <main class="content" id="w-main" role="main" tabindex="-1">${content}</main>
        </div>
      </div>`;

    this.querySelector('#w-logout')?.addEventListener('click', (e) => {
      e.preventDefault();
      localStorage.removeItem('watcher.token');
      localStorage.removeItem('watcher.user');
      location.href = '/login.html';
    });

    this.querySelector('#w-search-btn')?.addEventListener('click', () => openPalette());

    const themeBtn = this.querySelector('#w-theme');
    themeBtn?.addEventListener('click', () => {
      const now = toggleTheme();
      themeBtn.querySelector('.material-symbols-outlined').textContent =
        now === 'light' ? 'dark_mode' : 'light_mode';
    });

    this.#injectChromeStyles();
    this.#autoHealth();
    // Global keyboard shortcuts (⌘K palette, "/", g-then-key nav, "?") — install
    // once per document even though every page mounts a shell.
    if (!window.__wShortcuts) { window.__wShortcuts = true; installShortcuts(); }
  }

  /**
   * Keep the topbar status pill and sidebar alert badge live on every page by
   * polling the summary endpoint directly. Pages that already call setHealth()
   * (e.g. the dashboard) simply override this with fresher data.
   */
  #autoHealth() {
    const token = localStorage.getItem('watcher.token');
    if (!token) return;
    const poll = async () => {
      try {
        const res = await fetch('/api/nagios/summary', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) this.setHealth(await res.json());
      } catch { /* transient — try again next tick */ }
    };
    poll();
    this._healthTimer = setInterval(poll, 30_000);
  }

  disconnectedCallback() {
    if (this._healthTimer) clearInterval(this._healthTimer);
  }

  /** Update the topbar pill + counters and the sidebar alert badge —
   *  pages call this with /nagios/summary data. */
  setHealth(summary) {
    if (!summary) return;
    const criticals = summary.services.critical + summary.hosts.down;
    const warnings = summary.services.warning + summary.hosts.unreachable;

    const pill = this.querySelector('#w-status-pill');
    const text = this.querySelector('#w-status-text');
    if (pill && text) {
      pill.classList.remove('warning', 'critical');
      if (criticals > 0) { pill.classList.add('critical'); text.textContent = 'Status: Critical'; }
      else if (warnings > 0) { pill.classList.add('warning'); text.textContent = 'Status: Degraded'; }
      else text.textContent = 'Status: Optimal';
    }

    const badge = this.querySelector('#w-alert-badge');
    if (badge) {
      badge.hidden = criticals + warnings === 0;
      badge.textContent = criticals + warnings;
    }

    const el = this.querySelector('#w-health');
    if (el) {
      const pills = [
        ['down', summary.hosts.down, 'DOWN'],
        ['critical', summary.services.critical, 'CRIT'],
        ['warning', summary.services.warning, 'WARN'],
      ];
      el.innerHTML = pills
        .filter(([, count]) => count > 0)
        .map(([cls, count, label]) => `<span class="chip ${cls}">${count} ${label}</span>`)
        .join('');
    }
  }

  #injectChromeStyles() {
    if (document.getElementById('w-chrome-css')) return;
    const style = document.createElement('style');
    style.id = 'w-chrome-css';
    style.textContent = `
      .w-sidebar { background: var(--bg-low); border-right: 1px solid var(--border);
        display: flex; flex-direction: column; padding: 16px 8px 8px; position: sticky;
        top: 0; height: 100vh; }
      .w-brand { display: flex; align-items: center; gap: 10px; padding: 0 12px 16px; }
      .w-brand-mark { width: 36px; height: 36px; border-radius: var(--radius-sm);
        background: var(--accent-soft); border: 1px solid var(--border);
        display: grid; place-items: center; }
      .w-brand-name { font-size: 20px; font-weight: 700; line-height: 1.1;
        letter-spacing: -0.01em; color: var(--text-head); }
      .w-brand-ver { font-size: 11px; color: var(--text-faint); }
      .w-sidebar nav { display: flex; flex-direction: column; gap: 2px; flex: 1; }
      .w-sidebar nav a { display: flex; align-items: center; gap: 12px; padding: 8px 12px;
        border-left: 2px solid transparent; border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
        color: var(--text-dim); font-weight: 500; font-size: 14px; }
      .w-sidebar nav a .material-symbols-outlined { font-size: 20px; transition: transform .12s; }
      .w-sidebar nav a:hover { background: var(--bg-high); color: var(--text);
        text-decoration: none; }
      .w-sidebar nav a:hover .material-symbols-outlined { transform: scale(1.1); }
      .w-sidebar nav a.active { background: var(--nav-active-bg); color: var(--text-head);
        border-left-color: var(--text-head); font-weight: 600; }
      .w-badge { margin-left: auto; background: var(--critical-deep); color: #ffdad6;
        font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 2px; }
      .w-sidebar-foot { border-top: 1px solid rgba(69,70,76,0.3); padding-top: 8px; }
      .w-sidebar-foot a { display: flex; align-items: center; gap: 12px; padding: 8px 12px;
        color: var(--text-dim); font-size: 13px; border-radius: var(--radius-sm); }
      .w-sidebar-foot a:hover { background: var(--bg-high); color: var(--text);
        text-decoration: none; }
      .w-sidebar-foot .material-symbols-outlined { font-size: 18px; }
      .w-topbar { height: var(--topbar-h); display: flex; align-items: center; gap: 12px;
        padding: 0 16px; border-bottom: 1px solid var(--border-strong);
        background: var(--bg-raised); position: sticky; top: 0; z-index: 20; }
      .w-topbar-title { font-size: 15px; font-weight: 600; color: var(--text-head);
        white-space: nowrap; }
      .w-search { display: flex; align-items: center; gap: 8px; width: 320px;
        padding: 5px 8px 5px 10px; background: var(--bg-high); color: var(--text-faint);
        border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: text;
        text-align: left; transition: border-color .12s, color .12s; }
      .w-search:hover { border-color: var(--border-strong); color: var(--text-dim); }
      .w-search:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
      .w-search .material-symbols-outlined { font-size: 18px; }
      .w-search-ph { flex: 1; font-size: 13px; }
      .w-search-kbd { font-size: 11px; color: var(--text-faint); background: var(--bg-low);
        border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; }
      .w-icon-btn { display: grid; place-items: center; width: 30px; height: 30px;
        border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-high);
        color: var(--text-dim); cursor: pointer; transition: color .12s, border-color .12s; }
      .w-icon-btn:hover { color: var(--text-head); border-color: var(--border-strong); }
      .w-icon-btn .material-symbols-outlined { font-size: 18px; }
      .w-skip { position: absolute; left: 8px; top: -40px; z-index: 100;
        background: var(--accent); color: #061024; padding: 8px 14px; border-radius: 0 0 6px 6px;
        font-size: 13px; font-weight: 600; transition: top .12s; }
      .w-skip:focus { top: 0; text-decoration: none; }
      /* Visible keyboard-focus ring everywhere (keyboard users, WCAG 2.4.7). */
      a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible,
      textarea:focus-visible, [tabindex]:focus-visible {
        outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
      #w-main:focus { outline: none; }
      @media (prefers-reduced-motion: reduce) {
        * { animation-duration: .001ms !important; transition-duration: .001ms !important; }
      }
    `;
    document.head.appendChild(style);
  }
}

customElements.define('w-shell', WShell);
