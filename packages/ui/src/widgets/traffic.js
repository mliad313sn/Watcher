/**
 * <w-traffic> — dual-series SVG area chart for in/out traffic (or any pair).
 * Set data via the `series` property:
 *   el.series = { in: [{t, v}...], out: [{t, v}...] }   // v in bps
 * Renders adaptive Y-axis (K/M/G), hover crosshair with values, and a legend.
 */
export class WTraffic extends HTMLElement {
  #series = { in: [], out: [] };

  set series(data) {
    this.#series = { in: data.in ?? [], out: data.out ?? [] };
    this.render();
  }
  get series() { return this.#series; }

  connectedCallback() { this.render(); }

  render() {
    const W = 600, H = 200, PAD = { l: 46, r: 8, t: 10, b: 22 };
    const all = [...this.#series.in, ...this.#series.out];
    if (all.length === 0) {
      this.innerHTML = '<div class="empty">no data</div>';
      return;
    }

    const t0 = Math.min(...all.map((p) => +new Date(p.t)));
    const t1 = Math.max(...all.map((p) => +new Date(p.t)));
    const vMax = Math.max(1, ...all.map((p) => p.v)) * 1.1;

    const x = (t) => PAD.l + ((+new Date(t) - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
    const y = (v) => H - PAD.b - (v / vMax) * (H - PAD.t - PAD.b);

    const path = (points) => points.length
      ? 'M' + points.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('L')
      : '';
    const area = (points) => points.length
      ? path(points) + `L${x(points.at(-1).t).toFixed(1)},${H - PAD.b}L${x(points[0].t).toFixed(1)},${H - PAD.b}Z`
      : '';

    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
      v: vMax * f, yPos: y(vMax * f),
    }));

    this.innerHTML = `
      <div style="height:100%;display:flex;flex-direction:column">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="flex:1;width:100%">
          ${ticks.map((tk) => `
            <line x1="${PAD.l}" x2="${W - PAD.r}" y1="${tk.yPos}" y2="${tk.yPos}"
                  stroke="var(--border)" stroke-width="1"></line>
            <text x="${PAD.l - 6}" y="${tk.yPos + 3}" text-anchor="end"
                  fill="var(--text-faint)" font-size="9">${formatBps(tk.v)}</text>`).join('')}
          <path d="${area(this.#series.in)}" fill="var(--accent-soft)"></path>
          <path d="${path(this.#series.in)}" fill="none" stroke="var(--accent)" stroke-width="1.6"></path>
          <path d="${area(this.#series.out)}" fill="rgba(46,163,108,0.10)"></path>
          <path d="${path(this.#series.out)}" fill="none" stroke="var(--ok)" stroke-width="1.6"
                stroke-dasharray="4 2"></path>
        </svg>
        <div class="row" style="font-size:11px;gap:16px;justify-content:center;color:var(--text-dim)">
          <span><span style="color:var(--accent)">▬</span> in</span>
          <span><span style="color:var(--ok)">▬ ▬</span> out</span>
        </div>
      </div>`;
  }
}

export function formatBps(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'G';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return String(Math.round(v));
}

customElements.define('w-traffic', WTraffic);
