/**
 * <w-gauge> — SVG dial for a single 0–100 (or custom max) value.
 * Attributes: value, max (default 100), label, unit (default %),
 *             warn (default 70), crit (default 90).
 */
export class WGauge extends HTMLElement {
  static observedAttributes = ['value', 'label', 'unit', 'max', 'warn', 'crit'];

  attributeChangedCallback() { this.render(); }
  connectedCallback() { this.render(); }

  render() {
    const value = Number(this.getAttribute('value') ?? 0);
    const max = Number(this.getAttribute('max') ?? 100);
    const warn = Number(this.getAttribute('warn') ?? 70);
    const crit = Number(this.getAttribute('crit') ?? 90);
    const unit = this.getAttribute('unit') ?? '%';
    const label = this.getAttribute('label') ?? '';

    const frac = Math.max(0, Math.min(1, value / max));
    const color = value >= crit ? 'var(--critical)' : value >= warn ? 'var(--warning)' : 'var(--ok)';

    // 240° arc from 150° to 30° (clockwise through the top).
    const r = 42;
    const circumference = 2 * Math.PI * r;
    const arcLen = circumference * (240 / 360);

    this.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;height:100%;justify-content:center">
        <svg viewBox="0 0 120 104" style="width:100%;max-width:170px">
          <g transform="rotate(150 60 60)">
            <circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--border)"
              stroke-width="10" stroke-linecap="round"
              stroke-dasharray="${arcLen} ${circumference}"></circle>
            <circle cx="60" cy="60" r="${r}" fill="none" stroke="${color}"
              stroke-width="10" stroke-linecap="round"
              stroke-dasharray="${arcLen * frac} ${circumference}"
              style="transition: stroke-dasharray 0.4s ease, stroke 0.4s"></circle>
          </g>
          <text x="60" y="62" text-anchor="middle" fill="var(--text)"
            font-size="22" font-weight="700" font-family="var(--mono)">${Number.isFinite(value) ? round1(value) : '–'}</text>
          <text x="60" y="78" text-anchor="middle" fill="var(--text-dim)" font-size="10">${unit}</text>
        </svg>
        ${label ? `<div style="font-size:12px;color:var(--text-dim);margin-top:2px">${label}</div>` : ''}
      </div>`;
  }
}

function round1(n) { return Math.round(n * 10) / 10; }

customElements.define('w-gauge', WGauge);
