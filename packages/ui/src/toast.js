/**
 * toast(message, opts) — lightweight, dependency-free action feedback.
 *
 * Mutating actions (acknowledge, create, delete, recheck) previously gave no
 * confirmation, so operators couldn't tell success from a silent failure. A
 * toast closes that loop: a brief, dismissible, screen-reader-announced note.
 *
 *   import { toast } from '@watcher/ui';
 *   toast('Alert acknowledged', { type: 'success' });
 *   toast(err.message, { type: 'error' });
 *
 * Types: 'success' | 'error' | 'info' (default). Auto-dismisses after `ms`
 * (default 4000; errors linger longer). Respects prefers-reduced-motion.
 */
import { escapeHtml } from './escape.js';

const ICONS = { success: 'check_circle', error: 'gpp_maybe', info: 'bolt' };

function ensureHost() {
  let host = document.getElementById('w-toast-host');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'w-toast-host';
  // aria-live so assistive tech announces each toast as it appears.
  host.setAttribute('aria-live', 'polite');
  host.setAttribute('aria-atomic', 'false');
  document.body.appendChild(host);

  const style = document.createElement('style');
  style.textContent = `
    #w-toast-host { position: fixed; bottom: 20px; right: 20px; z-index: 1000;
      display: flex; flex-direction: column; gap: 10px; max-width: min(92vw, 380px); }
    .w-toast { display: flex; align-items: flex-start; gap: 10px; padding: 11px 14px;
      background: var(--bg-raised, #12151d); color: var(--text-head, #e8eaf0);
      border: 1px solid var(--border-strong, #2a2e39); border-left-width: 3px;
      border-radius: var(--radius-sm, 6px); box-shadow: 0 8px 28px rgba(0,0,0,.45);
      font-size: 13px; line-height: 1.4; animation: w-toast-in .18s ease-out; }
    .w-toast.success { border-left-color: var(--ok, #3ba55d); }
    .w-toast.error   { border-left-color: var(--critical, #e5484d); }
    .w-toast.info    { border-left-color: var(--accent, #4c8dff); }
    .w-toast .material-symbols-outlined { font-size: 18px; flex-shrink: 0; margin-top: 1px; }
    .w-toast.success .material-symbols-outlined { color: var(--ok, #3ba55d); }
    .w-toast.error   .material-symbols-outlined { color: var(--critical, #e5484d); }
    .w-toast.info    .material-symbols-outlined { color: var(--accent, #4c8dff); }
    .w-toast button { background: none; border: none; color: var(--text-faint, #7c8190);
      cursor: pointer; font-size: 16px; line-height: 1; padding: 0 0 0 4px; margin-left: auto; }
    .w-toast button:hover { color: var(--text-head, #e8eaf0); }
    .w-toast.leaving { animation: w-toast-out .16s ease-in forwards; }
    @keyframes w-toast-in  { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    @keyframes w-toast-out { to { opacity: 0; transform: translateY(8px); } }
    @media (prefers-reduced-motion: reduce) {
      .w-toast, .w-toast.leaving { animation: none; }
    }`;
  document.head.appendChild(style);
  return host;
}

export function toast(message, { type = 'info', ms } = {}) {
  const host = ensureHost();
  const el = document.createElement('div');
  el.className = `w-toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `
    <span class="material-symbols-outlined">${ICONS[type] ?? ICONS.info}</span>
    <span>${escapeHtml(String(message))}</span>
    <button type="button" aria-label="Dismiss">&times;</button>`;
  const remove = () => {
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 250); // fallback if animation is disabled
  };
  el.querySelector('button').addEventListener('click', remove);
  host.appendChild(el);
  const life = ms ?? (type === 'error' ? 7000 : 4000);
  setTimeout(remove, life);
  return remove;
}
