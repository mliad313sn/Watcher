/**
 * Drag-and-drop dashboard grid controller.
 *
 * Works over the `.dash-grid` 12-column CSS grid: widget headers are drag
 * handles (HTML5 DnD); on drop the widget snaps to the hovered column/row and
 * the new layout is reported through onLayoutChange so the page can PUT
 * /api/dashboards/:id/layout.
 */
import { escapeHtml } from './escape.js';

export class DashGrid {
  /**
   * @param {HTMLElement} container element with class="dash-grid"
   * @param {(layout: Array<{id,gridX,gridY,gridW,gridH}>) => void} onLayoutChange
   */
  constructor(container, onLayoutChange) {
    this.container = container;
    this.onLayoutChange = onLayoutChange;
    this.dragging = null;

    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    container.addEventListener('drop', (e) => this.#onDrop(e));
  }

  /** Render a widget shell into the grid; returns the .w-body element. */
  addWidget(widget) {
    const el = document.createElement('div');
    el.className = 'widget';
    el.dataset.widgetId = widget.id;
    this.#place(el, widget);
    el.innerHTML = `
      <div class="w-title" draggable="true">${escapeHtml(widget.title || widget.type)}</div>
      <div class="w-body"></div>`;

    const handle = el.querySelector('.w-title');
    handle.addEventListener('dragstart', (e) => {
      this.dragging = el;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Firefox needs data set for the drag to start.
      e.dataTransfer.setData('text/plain', widget.id);
    });
    handle.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      this.dragging = null;
    });

    this.container.appendChild(el);
    return el.querySelector('.w-body');
  }

  #place(el, w) {
    el.style.gridColumn = `${(w.grid_x ?? w.gridX ?? 0) + 1} / span ${w.grid_w ?? w.gridW ?? 4}`;
    el.style.gridRow = `${(w.grid_y ?? w.gridY ?? 0) + 1} / span ${w.grid_h ?? w.gridH ?? 3}`;
  }

  #onDrop(e) {
    if (!this.dragging) return;
    e.preventDefault();

    const rect = this.container.getBoundingClientRect();
    const style = getComputedStyle(this.container);
    const rowH = parseFloat(style.gridAutoRows) + parseFloat(style.gap);
    const colW = rect.width / 12;

    const col = Math.max(0, Math.min(11, Math.floor((e.clientX - rect.left) / colW)));
    const row = Math.max(0, Math.floor((e.clientY - rect.top) / rowH));

    const span = this.#spanOf(this.dragging);
    const gridX = Math.min(col, 12 - span.w);
    this.dragging.style.gridColumn = `${gridX + 1} / span ${span.w}`;
    this.dragging.style.gridRow = `${row + 1} / span ${span.h}`;

    this.onLayoutChange?.(this.layout());
  }

  #spanOf(el) {
    const colParts = el.style.gridColumn.match(/span (\d+)/);
    const rowParts = el.style.gridRow.match(/span (\d+)/);
    return { w: Number(colParts?.[1] ?? 4), h: Number(rowParts?.[1] ?? 3) };
  }

  /** Current layout of every widget in the grid. */
  layout() {
    return [...this.container.querySelectorAll('.widget')].map((el) => {
      const colStart = Number(el.style.gridColumn.split('/')[0]) - 1;
      const rowStart = Number(el.style.gridRow.split('/')[0]) - 1;
      const span = this.#spanOf(el);
      return {
        id: el.dataset.widgetId,
        gridX: colStart, gridY: rowStart, gridW: span.w, gridH: span.h,
      };
    });
  }
}
