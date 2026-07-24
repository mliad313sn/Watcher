/**
 * <w-eventfeed> — live-scrolling event/alert feed styled per the Aura
 * charter: dense rows on the deepest surface, 2px semantic left border,
 * mono timestamps. Call push(event) as WebSocket messages arrive; keeps the
 * newest `max` entries (default 100).
 * event: { severity|chipClass, title, detail, ts }
 */
const EDGE = {
  ok: 'var(--accent)', up: 'var(--accent)', info: 'var(--info)',
  warning: 'var(--warning)', unreachable: 'var(--warning)',
  critical: 'var(--critical)', down: 'var(--critical)',
  unknown: 'var(--unknown)', suppressed: 'var(--unknown)',
};

export class WEventfeed extends HTMLElement {
  #events = [];
  #max = 100;

  connectedCallback() {
    this.#max = Number(this.getAttribute('max') ?? 100);
    this.render();
  }

  push(event) {
    this.#events.unshift({ ...event, ts: event.ts ?? Date.now() });
    if (this.#events.length > this.#max) this.#events.pop();
    this.render();
  }

  set events(list) { this.#events = list ?? []; this.render(); }

  render() {
    if (this.#events.length === 0) {
      this.innerHTML = '<div class="empty mono">awaiting telemetry…</div>';
      return;
    }
    this.innerHTML = `
      <div style="overflow:auto;height:100%;display:flex;flex-direction:column;gap:2px">
        ${this.#events.map((e) => {
          const cls = e.chipClass ?? e.severity ?? 'info';
          return `
          <div style="display:flex;gap:10px;align-items:baseline;padding:5px 10px;
                      background:var(--bg-deep);border-left:2px solid ${EDGE[cls] ?? 'var(--unknown)'};
                      border-radius:2px">
            <span class="mono" style="font-size:11px;color:var(--text-faint);flex-shrink:0">${timeStamp(e.ts)}</span>
            <div style="min-width:0">
              <div style="font-weight:600;font-size:13px;color:var(--text-head)">${esc(e.title)}</div>
              ${e.detail ? `<div class="mono" style="font-size:11px;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.detail)}</div>` : ''}
            </div>
            <span class="chip ${cls}" style="margin-left:auto;flex-shrink:0">${esc(e.severity ?? cls)}</span>
          </div>`;
        }).join('')}
      </div>`;
  }
}

function esc(s) {
  return String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function timeStamp(ts) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}

customElements.define('w-eventfeed', WEventfeed);
