/**
 * <w-statusgrid> — compact host/service status table with severity chips.
 * el.rows = [{ host, service, stateName, output, chipClass }]
 * Emits 'row-click' with the row.
 */
import { escapeHtml as esc } from '../escape.js';

export class WStatusgrid extends HTMLElement {
  #rows = [];

  set rows(list) { this.#rows = list ?? []; this.render(); }
  get rows() { return this.#rows; }

  connectedCallback() { this.render(); }

  render() {
    if (this.#rows.length === 0) {
      this.innerHTML = '<div class="empty">nothing to show</div>';
      return;
    }
    this.innerHTML = `
      <div style="overflow:auto;height:100%">
        <table class="data">
          <thead><tr><th>Object</th><th>State</th><th>Output</th></tr></thead>
          <tbody>
            ${this.#rows.map((r, i) => `
              <tr data-i="${i}" style="cursor:pointer">
                <td style="white-space:nowrap"><strong>${esc(r.host)}</strong>${r.service ? `<span class="dim"> / ${esc(r.service)}</span>` : ''}</td>
                <td><span class="chip ${r.chipClass}">${esc(r.stateName)}</span></td>
                <td class="dim" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.output)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    this.querySelectorAll('tr[data-i]').forEach((el) => {
      el.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('row-click', {
          detail: this.#rows[Number(el.dataset.i)], bubbles: true,
        }));
      });
    });
  }
}

customElements.define('w-statusgrid', WStatusgrid);
