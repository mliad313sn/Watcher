/**
 * Guided tour — a spotlight that walks a first-time user through the live
 * console, anchored to real panels (not screenshots). Three-to-five steps,
 * dismissible at any point, never shows twice (localStorage), keyboard
 * navigable (←/→/Esc), reduced-motion aware.
 *
 *   startTour([{ el: '#tiles', title, body }, …], { key: 'watcher.tour.dashboard' })
 */
import { escapeHtml } from './escape.js';

export function tourSeen(key) {
  try { return localStorage.getItem(key) === '1'; } catch { return true; }
}

export function startTour(steps, { key } = {}) {
  const valid = steps.filter((s) => document.querySelector(s.el));
  if (valid.length === 0) return;
  let i = 0;
  const root = document.createElement('div');
  root.id = 'w-tour';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Product tour');
  root.innerHTML = `
    <div class="w-tour-dim"></div>
    <div class="w-tour-ring" aria-hidden="true"></div>
    <div class="w-tour-card">
      <div class="w-tour-step mono"></div>
      <h3></h3><p></p>
      <div class="w-tour-nav">
        <button type="button" class="w-tour-skip">Skip tour</button>
        <div style="display:flex;gap:8px">
          <button type="button" class="w-tour-prev">Back</button>
          <button type="button" class="w-tour-next"></button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(root);
  injectStyles();

  const ring = root.querySelector('.w-tour-ring');
  const card = root.querySelector('.w-tour-card');

  function place() {
    const s = valid[i];
    const el = document.querySelector(s.el);
    if (!el) return next();
    el.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    const r = el.getBoundingClientRect();
    const pad = 8;
    Object.assign(ring.style, {
      left: `${r.left - pad}px`, top: `${r.top - pad}px`,
      width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
    });
    root.querySelector('.w-tour-step').textContent = `${i + 1} / ${valid.length}`;
    root.querySelector('h3').textContent = s.title;
    root.querySelector('p').innerHTML = escapeHtml(s.body)
      .replace(/`([^`]+)`/g, '<kbd>$1</kbd>'); // allow `⌘K` styling in copy
    root.querySelector('.w-tour-prev').style.visibility = i === 0 ? 'hidden' : 'visible';
    root.querySelector('.w-tour-next').textContent = i === valid.length - 1 ? 'Finish' : 'Next';

    // Card below the target when there's room, else above.
    const ch = 172, gap = 14;
    const below = r.bottom + gap + ch < innerHeight;
    Object.assign(card.style, {
      top: below ? `${r.bottom + gap}px` : `${Math.max(12, r.top - gap - ch)}px`,
      left: `${Math.min(Math.max(12, r.left), innerWidth - 372)}px`,
    });
  }

  function finish() {
    try { if (key) localStorage.setItem(key, '1'); } catch { /* ignore */ }
    document.removeEventListener('keydown', onKey);
    removeEventListener('resize', place);
    root.remove();
  }
  function next() { if (i >= valid.length - 1) return finish(); i++; place(); }
  function prev() { if (i > 0) { i--; place(); } }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); finish(); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
  }

  root.querySelector('.w-tour-next').addEventListener('click', next);
  root.querySelector('.w-tour-prev').addEventListener('click', prev);
  root.querySelector('.w-tour-skip').addEventListener('click', finish);
  root.querySelector('.w-tour-dim').addEventListener('click', finish);
  document.addEventListener('keydown', onKey);
  addEventListener('resize', place);
  place();
  root.querySelector('.w-tour-next').focus();
}

function injectStyles() {
  if (document.getElementById('w-tour-css')) return;
  const s = document.createElement('style');
  s.id = 'w-tour-css';
  s.textContent = `
    #w-tour { position: fixed; inset: 0; z-index: 950; }
    .w-tour-dim { position: absolute; inset: 0; background: rgba(3,6,12,.55); }
    .w-tour-ring { position: fixed; border: 2px solid var(--accent, #4a8eff); border-radius: 10px;
      box-shadow: 0 0 0 6px var(--accent-soft, rgba(74,142,255,.14)), 0 0 0 9999px rgba(3,6,12,.55);
      pointer-events: none; transition: all .22s ease; }
    .w-tour-dim { background: transparent; } /* the ring's giant shadow does the dimming */
    .w-tour-card { position: fixed; width: 360px; max-width: calc(100vw - 24px);
      background: var(--bg-raised, #12161f); border: 1px solid var(--border-strong, #2a2e39);
      border-radius: 10px; padding: 16px 18px; box-shadow: 0 22px 60px rgba(0,0,0,.5);
      transition: top .22s ease, left .22s ease; }
    .w-tour-step { font-size: 11px; color: var(--text-faint, #7c8190); letter-spacing: .08em; }
    .w-tour-card h3 { margin: 6px 0 0; font-size: 16px; color: var(--text-head, #e8eaf0); }
    .w-tour-card p { margin: 7px 0 0; font-size: 13.5px; line-height: 1.5; color: var(--text-dim, #a4a9b6); }
    .w-tour-card kbd { font-family: var(--mono, monospace); font-size: 11px;
      background: var(--bg-high, #1b1f29); border: 1px solid var(--border, #21242e);
      border-radius: 4px; padding: 1px 5px; color: var(--text, #c8ccd6); }
    .w-tour-nav { display: flex; justify-content: space-between; align-items: center; margin-top: 14px; }
    .w-tour-nav button { font: inherit; font-size: 13px; cursor: pointer; border-radius: 6px;
      padding: 6px 13px; border: 1px solid var(--border, #21242e);
      background: var(--bg-high, #1b1f29); color: var(--text, #c8ccd6); }
    .w-tour-next { background: var(--accent, #4a8eff) !important; color: #071022 !important;
      border-color: transparent !important; font-weight: 600; }
    .w-tour-skip { background: none !important; border: none !important;
      color: var(--text-faint, #7c8190) !important; padding-left: 0 !important; }
    .w-tour-skip:hover { color: var(--text, #c8ccd6) !important; }
    @media (prefers-reduced-motion: reduce) {
      .w-tour-ring, .w-tour-card { transition: none; }
    }`;
  document.head.appendChild(s);
}
