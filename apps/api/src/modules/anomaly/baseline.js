/**
 * Robust statistical baseline — the math behind dynamic thresholds.
 *
 * Median + MAD (median absolute deviation) instead of mean + σ, so a history
 * that already contains spikes doesn't inflate its own threshold and mask the
 * next incident. Deterministic and explainable by design: every anomaly can be
 * stated as "value X is Nx the normal deviation from its usual level" — no ML
 * theatre, no unexplainable score.
 */

/** Median of a numeric array (copies; does not mutate). */
export function median(values) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Build a baseline from history.
 * @returns {{median: number, mad: number, n: number} | null}
 *   null when there's too little history to judge (never alert on ignorance).
 */
export function robustBaseline(values, { minSamples = 12 } = {}) {
  const clean = values.filter(Number.isFinite);
  if (clean.length < minSamples) return null;
  const med = median(clean);
  const mad = median(clean.map((v) => Math.abs(v - med)));
  return { median: med, mad, n: clean.length };
}

/**
 * Modified z-score of a value against a baseline (0.6745 scales MAD to be
 * σ-comparable for normal data). A completely flat history (mad = 0) falls
 * back to a small fraction of the median so any real movement still registers,
 * without a divide-by-zero making every wiggle "infinite".
 */
export function anomalyScore(value, baseline) {
  if (!baseline || !Number.isFinite(value)) return 0;
  const scale = baseline.mad > 0
    ? baseline.mad
    : Math.max(Math.abs(baseline.median) * 0.05, 1e-9);
  return (0.6745 * (value - baseline.median)) / scale;
}

/**
 * Judge a value. Deviation must be BOTH statistically large (|z| ≥ zThreshold)
 * and practically large (≥ minDeltaPct of the median) — the second guard stops
 * a metric that's flat at 3.00 from alerting at 3.02.
 */
export function judge(value, baseline, { zThreshold = 4, minDeltaPct = 10 } = {}) {
  if (!baseline) return { anomalous: false, z: 0 };
  const z = anomalyScore(value, baseline);
  const deltaPct = baseline.median !== 0
    ? Math.abs((value - baseline.median) / baseline.median) * 100
    : (value === 0 ? 0 : 100);
  return {
    anomalous: Math.abs(z) >= zThreshold && deltaPct >= minDeltaPct,
    z: Number(z.toFixed(2)),
    deltaPct: Number(deltaPct.toFixed(1)),
  };
}
