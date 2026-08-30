/**
 * Small shared formatting helpers. Kept dependency-free so every page and
 * widget can use them without pulling in a date library.
 */

/**
 * Compact relative time, e.g. "now", "6m", "3h", "2d", "5w". Operators scan
 * alert lists for recency; a relative stamp reads faster than a wall-clock
 * time and needs no timezone math.
 * @param {number|string|Date} when epoch ms, ISO string, or Date
 * @returns {string}
 */
export function timeAgo(when) {
  const t = when instanceof Date ? when.getTime()
    : typeof when === 'number' ? when : Date.parse(when);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 0) return 'now';
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d`;
  if (s < 30 * 86400) return `${Math.round(s / (7 * 86400))}w`;
  return `${Math.round(s / (30 * 86400))}mo`;
}
