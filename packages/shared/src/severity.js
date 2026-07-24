/** Watcher severity model — shared by the API, pollers, and UI. */

export const SEVERITY = Object.freeze({
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info',
});

/** Sort weight: higher is worse. */
export const SEVERITY_WEIGHT = Object.freeze({
  critical: 3,
  warning: 2,
  info: 1,
});

export const ALERT_STATUS = Object.freeze({
  OPEN: 'open',
  ACKNOWLEDGED: 'acknowledged',
  SUPPRESSED: 'suppressed',
  RESOLVED: 'resolved',
});

export function worstSeverity(list) {
  let worst = null;
  for (const s of list) {
    if (!worst || (SEVERITY_WEIGHT[s] ?? 0) > (SEVERITY_WEIGHT[worst] ?? 0)) worst = s;
  }
  return worst;
}
