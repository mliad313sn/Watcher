/**
 * <w-heatmap> — dense grid of colored cells, one per object.
 * Set data via the `cells` property:
 *   el.cells = [{ id, label, value, state }]
 * `state` (ok|warning|critical|unknown) wins when present; otherwise `value`
 * (0–100) drives a green→amber→red ramp. Emits 'cell-click' with the cell.
 */
export class WHeatmap extends HTMLElement {
  #cells = [];

  set cells(list) { this.#cells = list ?? []; this.render(); }
  get cells() { return this.#cells; }

  connectedCallback() { this.render(); }

  #color(cell) {
    if (cell.state === 'critical') return 'var(--critical)';
    if (cell.state === 'warning') return 'var(--warning)';
    if (cell.state === 'unknown') return 'var(--unknown)';
    if (cell.state === 'ok') return 'var(--ok)';
    const v = Math.max(0, Math.min(100, cell.value ?? 0));
    if (v >= 90) return 'var(--critical)';
    if (v >= 70) return 'var(--warning)';
    return 'var(--ok)';
  }

  render() {
    if (this.#cells.length === 0) {
      this.innerHTML = '<div class="empty">no data</div>';
      return;
    }
    this.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(26px,1fr));gap:4px;height:100%;align-content:start">
        ${this.#cells.map((c, i) => `
          <div data-i="${i}" title="${escapeAttr(c.label)}${c.value !== undefined ? ` — ${Math.round(c.value)}%` : ''}"
               style="aspect-ratio:1;border-radius:4px;background:${this.#color(c)};
                      opacity:${c.state ? 1 : 0.35 + 0.65 * Math.min(1, (c.value ?? 0) / 100)};
                      cursor:pointer;transition:transform .1s"
               onmouseover="this.style.transform='scale(1.2)'"
               onmouseout="this.style.transform=''"></div>`).join('')}
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
