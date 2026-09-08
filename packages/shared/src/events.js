/**
 * The event plane — the model shared by the SNMP trap and syslog receivers,
 * the rule engine that decides what an event means, and the API that
 * searches them.
 *
 * Watcher's alert stack (dedup, dependency suppression, maintenance windows,
 * on-call, runbooks, escalation) hangs off ONE contract: a state event on
 * `watcher:events:state`. Events therefore do not get an alert path of their
 * own — a rule turns an event into a state event, and everything downstream
 * is the code that was already there. There is one alert model in this
 * product, and this is how it stays that way.
 *
 * The asymmetry that shapes everything here: a poll has an OK to come back
 * to, and an event does not. A trap saying the PSU failed is never followed
 * by a trap saying it did not. So a rule that raises must also say how the
 * thing it raised ends — a paired clearing rule, or a time after which the
 * alert closes itself. A rule that does neither is a pager that never stops,
 * which is how people learn to ignore a monitoring system.
 */
import { SEVERITY } from './severity.js';
import { SERVICE_STATE } from './nagios-states.js';

/** Where an event came from. */
export const EVENT_SOURCE = Object.freeze({
  TRAP: 'trap',
  SYSLOG: 'syslog',
});

/** What a matching rule does with the event. */
export const RULE_ACTION = Object.freeze({
  ALERT: 'alert',   // raise (or refresh) an alert
  CLEAR: 'clear',   // resolve the alert this rule's check_name names
  DROP: 'drop',     // stop here — do not even store it
  LOG: 'log',       // store and show it, but never page
});

/**
 * How an unmatched event is treated. Storing it is the point: the first
 * thing anyone does with a new trap is look at what the device actually
 * sent, and they can only do that if we kept it.
 */
export const DEFAULT_ACTION = RULE_ACTION.LOG;

/**
 * Patterns are operator-authored, but they are still compiled at runtime
 * against attacker-influenced message text, and JavaScript has no regex
 * timeout. Two bounds keep that honest: a pattern long enough to hide a
 * catastrophic backtrack is refused, and the text a pattern is applied to
 * is truncated. Neither is a proof, and both turn an unbounded stall into
 * a bounded one.
 */
export const MAX_PATTERN_LENGTH = 512;
export const MAX_MATCH_LENGTH = 4096;

const compiled = new Map();

/**
 * Compile a rule pattern, memoised, returning null for an empty pattern
 * (which matches everything) or one we refuse. A bad regex from the rules
 * table must never take the receiver down with it.
 */
export function compilePattern(pattern) {
  if (!pattern) return null;
  if (pattern.length > MAX_PATTERN_LENGTH) return null;
  if (compiled.has(pattern)) return compiled.get(pattern);
  let re = null;
  try { re = new RegExp(pattern, 'i'); } catch { re = null; }
  if (compiled.size > 500) compiled.clear();
  compiled.set(pattern, re);
  return re;
}

/**
 * Does an OID fall under a rule's OID selector?
 *
 * Trap OIDs are hierarchical, so a selector is a prefix — but on label
 * boundaries only. `1.3.6.1.4.1.9` must select `1.3.6.1.4.1.9.1.1` and must
 * NOT select `1.3.6.1.4.1.99`, which belongs to a different vendor
 * altogether. Plain `startsWith` gets that wrong, and gets it wrong in the
 * direction that pages the wrong team.
 */
export function oidMatches(selector, oid) {
  if (!selector) return true;
  if (!oid) return false;
  const s = selector.replace(/^\.|\.$/g, '');
  const o = String(oid).replace(/^\./, '');
  if (o === s) return true;
  return o.startsWith(s + '.');
}

/** Does this rule apply to this event at all? */
export function ruleMatches(rule, event) {
  if (rule.enabled === false) return false;
  if (rule.source && rule.source !== 'any' && rule.source !== event.source) return false;

  if (rule.matchOid && !oidMatches(rule.matchOid, event.oid)) return false;

  if (rule.matchFacility !== null && rule.matchFacility !== undefined
      && rule.matchFacility !== event.facility) return false;

  // Syslog severity counts DOWN — 0 is emerg. "maxSeverity: 3" means
  // err and worse, which is the way an operator says it out loud.
  if (rule.maxSeverity !== null && rule.maxSeverity !== undefined) {
    if (event.severity === null || event.severity === undefined) return false;
    if (event.severity > rule.maxSeverity) return false;
  }

  if (rule.matchApp && rule.matchApp !== event.appName) return false;

  if (rule.matchPattern) {
    const re = compilePattern(rule.matchPattern);
    if (!re) return false;                 // refused pattern matches nothing
    if (!re.test(String(event.message ?? '').slice(0, MAX_MATCH_LENGTH))) return false;
  }
  return true;
}

/**
 * Expand a check-name template. An event's check name is what the alert
 * dedups on, so it decides whether a thousand traps are one alert or a
 * thousand: `{oid}` alone folds a flapping port and a failed PSU into the
 * same row, while `port {1}` keeps them apart. That choice belongs to the
 * person writing the rule, so it is a template rather than a constant.
 *
 * `{1}`…`{9}` are capture groups from the rule's pattern.
 */
export function expandTemplate(template, event, captures = []) {
  if (!template) return '';
  return String(template).replace(/\{(\w+)\}/g, (whole, key) => {
    if (/^[1-9]$/.test(key)) return captures[Number(key)] ?? '';
    switch (key) {
      case 'oid': return event.oid ?? '';
      case 'app': return event.appName ?? '';
      case 'host': return event.deviceName ?? '';
      case 'facility': return event.facilityName ?? '';
      case 'severity': return event.severityName ?? '';
      default: return whole;
    }
  }).trim();
}

/**
 * Evaluate an event against an ordered rule set. First match wins: rules
 * are a decision list, not a scoring function, because an operator asked
 * "why did this page me" deserves one rule to read, not seven that
 * combined into a number.
 *
 * @returns {{action: string, severity: string|null, checkName: string,
 *            autoClearSeconds: number|null, ruleId: string|null,
 *            ruleName: string}}
 */
export function evaluateEvent(rules, event) {
  const ordered = [...(rules ?? [])].sort(
    (a, b) => (a.priority ?? 100) - (b.priority ?? 100) || String(a.id).localeCompare(String(b.id)));

  for (const rule of ordered) {
    if (!ruleMatches(rule, event)) continue;

    let captures = [];
    if (rule.matchPattern) {
      const re = compilePattern(rule.matchPattern);
      const m = re?.exec(String(event.message ?? '').slice(0, MAX_MATCH_LENGTH));
      if (m) captures = m;
    }
    const checkName = expandTemplate(rule.checkName, event, captures)
      || defaultCheckName(event);

    return {
      action: rule.action ?? RULE_ACTION.ALERT,
      severity: rule.severity ?? SEVERITY.WARNING,
      checkName,
      autoClearSeconds: rule.autoClearSeconds ?? null,
      ruleId: rule.id ?? null,
      ruleName: rule.name ?? '',
    };
  }

  return {
    action: DEFAULT_ACTION,
    severity: null,
    checkName: defaultCheckName(event),
    autoClearSeconds: null,
    ruleId: null,
    ruleName: '',
  };
}

/** What we call a check when no rule named one. */
export function defaultCheckName(event) {
  if (event.source === EVENT_SOURCE.TRAP) return `trap ${event.oid ?? 'unknown'}`;
  return `syslog ${event.appName || event.facilityName || 'message'}`;
}

/**
 * The Watcher severity a raising rule produces, expressed as the service
 * state code the state bus carries — so an event-born alert and a
 * Nagios-born one are indistinguishable to everything downstream.
 */
export function severityToServiceState(severity) {
  if (severity === SEVERITY.CRITICAL) return SERVICE_STATE.CRITICAL;
  if (severity === SEVERITY.WARNING) return SERVICE_STATE.WARNING;
  return SERVICE_STATE.UNKNOWN;          // 'info' — visible, does not page
}

/**
 * Suggest a severity for a syslog event that no rule claimed, used only to
 * colour the event list. It never raises anything on its own: an
 * unrecognised message is a message we do not understand, and a monitoring
 * system that pages on those trains people to silence it.
 */
export function syslogSeverityHint(severity) {
  if (severity === null || severity === undefined) return SEVERITY.INFO;
  if (severity <= 2) return SEVERITY.CRITICAL;    // emerg, alert, crit
  if (severity <= 4) return SEVERITY.WARNING;     // err, warning
  return SEVERITY.INFO;
}
