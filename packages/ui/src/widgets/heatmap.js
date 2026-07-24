/**
 * <w-heatmap> — dense grid of cells, one per object, with 1px gaps per the
 * Aura charter. Color scale: background (cold) → electric blue (active) →
 * warning orange → critical red (hot). Explicit `state` wins over `value`.
 *   el.cells = [{ id, label, value, state }]
 * Emits 'cell-click' with the cell.
 */
export class WHeatmap extends HTMLElement {
  #cells = [];

  set cells(list) { this.#cells = list ?? []; this.render(); }
  get cells() { return this.#cells; }

  connectedCallback() { this.render(); }

  #color(cell) {
    if (cell.state === 'critical') return 'var(--critical-deep)';
    if (cell.state === 'warning') return 'var(--warning)';
    if (cell.state === 'unknown') return 'var(--bg-hover)';
    if (cell.state === 'ok') return 'var(--accent)';
    const v = Math.max(0, Math.min(100, cell.value ?? 0));
    if (v >= 90) return 'var(--critical-deep)';
    if (v >= 70) return 'var(--warning)';
    return 'var(--accent)';
  }

  #opacity(cell) {
    if (cell.state === 'critical' || cell.state === 'warning') return 1;
    if (cell.state === 'ok') return 0.8;
    if (cell.state === 'unknown') return 1;
    return 0.25 + 0.75 * Math.min(1, (cell.value ?? 0) / 100);
  }

  render() {
    if (this.#cells.length === 0) {
      this.innerHTML = '<div class="empty">no data</div>';
      return;
    }
    this.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(24px,1fr));gap:1px;height:100%;align-content:start;background:var(--bg-deep);padding:1px;border-radius:2px">
        ${this.#cells.map((c, i) => `
          <div data-i="${i}" title="${escapeAttr(c.label)}${c.value !== undefined ? ` — ${Math.round(c.value)}%` : ''}"
               style="aspect-ratio:1;border-radius:1px;background:${this.#color(c)};
                      opacity:${this.#opacity(c)};cursor:pointer;transition:filter .1s"
               onmouseover="this.style.filter='brightness(1.4)'"
               onmouseout="this.style.filter=''"></div>`).join('')}
      </div>`;

    this.querySelectorAll('[data-i]').forEach((el) => {
      el.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('cell-click', {
          detail: this.#cells[Number(el.dataset.i)], bubbles: true,
        }));
      });
    });
  }
}

function escapeAttr(s) {
  return String(s ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

customElements.define('w-heatmap', WHeatmap);
