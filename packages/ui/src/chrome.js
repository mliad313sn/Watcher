/**
 * <w-shell> — shared application chrome for every page of the MPA:
 * sidebar navigation, topbar with live health summary, user menu.
 *
 * Usage (in each page):
 *   <w-shell active="alerts" title="Alerts"> ...page content... </w-shell>
 */

const NAV = [
  { id: 'dashboard', href: '/index.html', label: 'Dashboard', icon: 'M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z' },
  { id: 'devices', href: '/devices.html', label: 'Devices', icon: 'M4 6h16v10H4zm4 14h8m-4-4v4' },
  { id: 'alerts', href: '/alerts.html', label: 'Alerts', icon: 'M12 3l9 16H3zm0 6v4m0 3h.01' },
  { id: 'topology', href: '/topology.html', label: 'Topology', icon: 'M12 3v6m0 0L5 15m7-6l7 6M3 19h4m10 0h4' },
  { id: 'reports', href: '/reports.html', label: 'Reports', icon: 'M4 20V10m6 10V4m6 16v-7m4 7H2' },
  { id: 'settings', href: '/settings.html', label: 'Settings', icon: 'M12 8a4 4 0 100 8 4 4 0 000-8zm8 4h2M2 12h2m8-10v2m0 16v2' },
];

export class WShell extends HTMLElement {
  connectedCallback() {
    const active = this.getAttribute('active') ?? '';
    const title = this.getAttribute('title') ?? 'Watcher';
    const content = this.innerHTML;
    const user = JSON.parse(localStorage.getItem('watcher.user') ?? 'null');

    this.innerHTML = `
      <div class="shell">
        <aside class="w-sidebar">
          <div class="w-brand">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none"
                 stroke="var(--accent)" stroke-width="2" stroke-linecap="round">
              <circle cx="12" cy="12" r="9"></circle>
              <path d="M12 7v5l3 3"></path>
            </svg>
            <span>Watcher</span>
          </div>
          <nav>
            ${NAV.map((n) => `
              <a href="${n.href}" class="${n.id === active ? 'active' : ''}">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none"
                     stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
                     stroke-linejoin="round"><path d="${n.icon}"></path></svg>
                ${n.label}
              </a>`).join('')}
          </nav>
          <div class="w-sidebar-foot">
            <span class="dim">${user ? `${user.displayName ?? user.username}` : ''}</span>
            <a href="#" id="w-logout">Sign out</a>
          </div>
        </aside>
        <div class="main">
          <header class="w-topbar">
            <strong>${title}</strong>
            <div class="grow"></div>
            <div id="w-health" class="row"></div>
          </header>
          <div class="content">${content}</div>
        </div>
      </div>`;

    this.querySelector('#w-logout')?.addEventListener('click', (e) => {
      e.preventDefault();
      localStorage.removeItem('watcher.token');
      localStorage.removeItem('watcher.user');
      location.href = '/login.html';
    });

    this.#injectChromeStyles();
  }

  /** Update the topbar health pills — pages call this with /nagios/summary data. */
  setHealth(summary) {
    const el = this.querySelector('#w-health');
    if (!el || !summary) return;
    const pills = [
      ['down', summary.hosts.down, 'hosts down'],
      ['warning', summary.services.warning, 'warning'],
      ['critical', summary.services.critical, 'critical'],
      ['ok', summary.services.ok, 'ok'],
    ];
    el.innerHTML = pills
      .filter(([, count]) => count > 0)
      .map(([cls, count, label]) => `<span class="chip ${cls}">${count} ${label}</span>`)
      .join('');
  }

  #injectChromeStyles() {
    if (document.getElementById('w-chrome-css')) return;
    const style = document.createElement('style');
    style.id = 'w-chrome-css';
    style.textContent = `
      .w-sidebar { background: var(--bg-raised); border-right: 1px solid var(--border);
        display: flex; flex-direction: column; padding: 14px 10px; position: sticky;
        top: 0; height: 100vh; }
      .w-brand { display: flex; align-items: center; gap: 9px; font-size: 16px;
        font-weight: 700; letter-spacing: -0.01em; padding: 4px 10px 16px; }
      .w-sidebar nav { display: flex; flex-direction: column; gap: 2px; flex: 1; }
      .w-sidebar nav a { display: flex; align-items: center; gap: 10px; padding: 9px 10px;
        border-radius: var(--radius-sm); color: var(--text-dim); font-weight: 500; }
      .w-sidebar nav a:hover { background: var(--bg-hover); color: var(--text); text-decoration: none; }
      .w-sidebar nav a.active { background: var(--accent-soft); color: var(--accent); }
      .w-sidebar-foot { display: flex; justify-content: space-between; padding: 10px;
        font-size: 12px; border-top: 1px solid var(--border); }
      .w-topbar { height: var(--topbar-h); display: flex; align-items: center; gap: 12px;
        padding: 0 24px; border-bottom: 1px solid var(--border); background: var(--bg-raised);
        position: sticky; top: 0; z-index: 10; }
    `;
    document.head.appendChild(style);
  }
}

customElements.define('w-shell', WShell);
