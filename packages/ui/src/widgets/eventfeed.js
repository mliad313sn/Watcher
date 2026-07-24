/**
 * <w-eventfeed> — live-scrolling event/alert feed. Call push(event) as
 * WebSocket messages arrive; keeps the newest `max` entries (default 100).
 * event: { severity|chipClass, title, detail, ts }
 */
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
      this.innerHTML = '<div class="empty">waiting for events…</div>';
      return;
    }
    this.innerHTML = `
      <div style="overflow:auto;height:100%;display:flex;flex-direction:column;gap:6px">
        ${this.#events.map((e) => `
          <div style="display:flex;gap:10px;align-items:baseline;padding:7px 10px;
                      background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm)">
            <span class="chip ${e.chipClass ?? e.severity ?? 'info'}" style="flex-shrink:0">${esc(e.severity ?? '')}</span>
            <div style="min-width:0">
              <div style="font-weight:600">${esc(e.title)}</div>
              ${e.detail ? `<div class="dim" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.detail)}</div>` : ''}
            </div>
            <span class="dim mono" style="margin-left:auto;font-size:11px;flex-shrink:0">${timeAgo(e.ts)}</span>
          </div>`).join('')}
      </div>`;
  }
}

function esc(s) {
  return String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

customElements.define('w-eventfeed', WEventfeed);
