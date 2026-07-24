/**
 * HTML escaping helpers — the single source of truth for the UI.
 *
 * Data rendered in the console frequently originates from monitored devices
 * (Nagios plugin output, SNMP sysName/ifName, device/host/service names) and
 * is therefore attacker-influenceable: a compromised monitored host must not
 * be able to inject script into an operator's session. Use `escapeHtml` for
 * text/element context and `escapeAttr` for anything placed inside a quoted
 * attribute (it also escapes quotes, which the old per-file `esc()` did not).
 */

/** Escape for HTML text/element context. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** Escape for a double- or single-quoted HTML attribute value. */
export function escapeAttr(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
