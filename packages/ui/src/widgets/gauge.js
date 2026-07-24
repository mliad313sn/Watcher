/**
 * <w-gauge> — circular gauge per the Aura charter: thick 10%-opacity track,
 * electric-blue (or semantic) fill with a soft glow, JetBrains Mono value
 * centered. Attributes: value, max (default 100), label, unit (default %),
 * warn (default 70), crit (default 90).
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
    // Nominal is electric blue; orange/red only on threshold breach.
    const color = value >= crit ? 'var(--critical)'
      : value >= warn ? 'var(--warning)'
      : 'var(--accent)';

    const r = 40;
    const circumference = 2 * Math.PI * r;

    this.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;height:100%;justify-content:center">
        <div style="position:relative;width:100%;max-width:160px;aspect-ratio:1">
          <svg viewBox="0 0 100 100" style="width:100%;height:100%">
            <circle cx="50" cy="50" r="${r}" fill="none"
              stroke="rgba(193, 198, 220, 0.1)" stroke-width="8"></circle>
            ${frac > 0 ? `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${color}"
              stroke-width="8" stroke-linecap="round"
              stroke-dasharray="${(circumference * frac).toFixed(1)} ${circumference.toFixed(1)}"
              transform="rotate(-90 50 50)"
              style="filter: drop-shadow(0 0 4px ${color});
                     transition: stroke-dasharray 0.4s ease, stroke 0.4s"></circle>` : ''}
          </svg>
          <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none">
            <span style="font-family:var(--mono);font-size:24px;font-weight:700;letter-spacing:-0.02em;color:var(--text-head)">${Number.isFinite(value) ? round1(value) : '–'}</span>
            <span class="label-caps" style="font-size:10px">${unit}</span>
          </div>
        </div>
        ${label ? `<div class="label-caps" style="margin-top:4px">${label}</div>` : ''}
      </div>`;
  }
}

function round1(n) { return Math.round(n * 10) / 10; }

customElements.define('w-gauge', WGauge);
