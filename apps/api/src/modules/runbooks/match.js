/**
 * Runbook matching — pure and unit-testable.
 *
 * Given an alert (and its device, for kind/tags) plus the tenant's runbooks,
 * return the best-matching runbook or null. A runbook matches when every
 * criterion it specifies holds; among matches, higher `priority` wins, then
 * the more specific rule (more criteria), then the earliest created.
 */
import { SEVERITY_WEIGHT } from '@watcher/shared';

function matches(runbook, alert, device) {
  const m = runbook.match ?? {};
  if (m.minSeverity && SEVERITY_WEIGHT[alert.severity] < SEVERITY_WEIGHT[m.minSeverity]) return false;
  if (m.kind && device?.kind !== m.kind) return false;
  if (m.tags && device) {
    for (const [k, v] of Object.entries(m.tags)) {
      if ((device.tags ?? {})[k] !== v) return false;
    }
  }
  if (m.checkPattern) {
    try { if (!new RegExp(m.checkPattern, 'i').test(alert.check_name ?? '')) return false; }
    catch { return false; }
  }
  if (m.devicePattern) {
    try { if (!new RegExp(m.devicePattern, 'i').test(alert.device_name ?? '')) return false; }
    catch { return false; }
  }
  return true;
}

function specificity(runbook) {
  const m = runbook.match ?? {};
  return ['kind', 'tags', 'checkPattern', 'devicePattern', 'minSeverity']
    .reduce((n, k) => n + (m[k] != null ? 1 : 0), 0);
}

export function matchRunbook({ alert, device, runbooks }) {
  const candidates = runbooks.filter((r) => r.enabled !== false && matches(r, alert, device));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) =>
    (b.priority ?? 0) - (a.priority ?? 0)
    || specificity(b) - specificity(a)
    || new Date(a.created_at ?? 0) - new Date(b.created_at ?? 0));
  return candidates[0];
}
