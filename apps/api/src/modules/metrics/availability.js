/**
 * Pure availability integrator — extracted from the route so it can be unit
 * tested (issue #8). Given the window's opening state and the ordered hard
 * transitions inside the window, returns the downtime in ms.
 *
 * @param {object} p
 * @param {Array<{time: string|number|Date, to_state: number}>} p.transitions
 * @param {boolean} p.initialBad  was the object non-OK at windowStart?
 * @param {number}  p.windowStartMs
 * @param {number}  p.nowMs
 * @returns {number} downtime in milliseconds
 */
export function integrateDowntime({ transitions, initialBad, windowStartMs, nowMs }) {
  let downMs = 0;
  let cursor = windowStartMs;
  let currentBad = initialBad;
  for (const row of transitions) {
    const t = new Date(row.time).getTime();
    if (currentBad) downMs += t - cursor;
    cursor = t;
    currentBad = row.to_state !== 0;
  }
  if (currentBad) downMs += nowMs - cursor;
  return downMs;
}
