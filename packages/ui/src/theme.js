/**
 * Theme control. Watcher is dark-first; a viewer may force light or dark, or
 * leave it on "system" (follow the OS). The choice persists per browser.
 *
 * No-flash: each page's <head> carries a tiny inline script that stamps
 * data-theme before first paint (see the MPA HTML). This module is the
 * runtime control used by the toggle and the command palette.
 */
const KEY = 'watcher.theme';

/** Stored preference: 'light' | 'dark' | null (=follow system). */
export function storedTheme() {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

/** What the viewer actually sees right now, resolving "system". */
export function effectiveTheme() {
  const t = storedTheme();
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Apply a preference: 'light' | 'dark' | null (clear → follow system). */
export function applyTheme(pref) {
  const root = document.documentElement;
  if (pref === 'light' || pref === 'dark') {
    root.dataset.theme = pref;
    try { localStorage.setItem(KEY, pref); } catch { /* ignore */ }
  } else {
    delete root.dataset.theme;
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  }
  window.dispatchEvent(new CustomEvent('watcher:themechange', { detail: { theme: effectiveTheme() } }));
}

/** Flip to the opposite of what's currently shown (makes the choice explicit). */
export function toggleTheme() {
  applyTheme(effectiveTheme() === 'light' ? 'dark' : 'light');
  return effectiveTheme();
}
