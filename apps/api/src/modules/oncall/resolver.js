/**
 * On-call resolution — pure, deterministic, and unit-testable.
 *
 * Given a schedule's rotation and its participants (plus any overrides), work
 * out who is on call at an instant, and when the next handoff happens. The
 * rotation is a simple modular walk over the ordered participants, anchored at
 * `handoffAt`; an active override always wins.
 */

/**
 * @param {object} p
 * @param {{handoffAt: Date|string|number, rotationIntervalS: number}} p.schedule
 * @param {Array<{position: number, name: string, contact: object}>} p.participants
 * @param {Array<{name: string, contact: object, startsAt: Date|string|number, endsAt: Date|string|number}>} [p.overrides]
 * @param {number} [p.nowMs]
 * @returns {{onCall: object|null, source: 'override'|'rotation'|'none',
 *            index: number|null, nextHandoffMs: number|null,
 *            overrideEndsMs: number|null}}
 */
export function whoIsOnCall({ schedule, participants, overrides = [], nowMs = Date.now() }) {
  // 1) An active override takes precedence over the rotation.
  const active = overrides
    .map((o) => ({ ...o, s: +new Date(o.startsAt), e: +new Date(o.endsAt) }))
    .filter((o) => o.s <= nowMs && nowMs < o.e)
    .sort((a, b) => a.e - b.e)[0]; // the soonest-ending active cover
  if (active) {
    return {
      onCall: { name: active.name, contact: active.contact },
      source: 'override', index: null,
      nextHandoffMs: active.e, overrideEndsMs: active.e,
    };
  }

  const ordered = [...participants].sort((a, b) => a.position - b.position);
  if (ordered.length === 0) {
    return { onCall: null, source: 'none', index: null, nextHandoffMs: null, overrideEndsMs: null };
  }

  const anchor = +new Date(schedule.handoffAt);
  const interval = schedule.rotationIntervalS * 1000;
  const shifts = Math.floor((nowMs - anchor) / interval); // may be negative pre-start
  const n = ordered.length;
  const index = ((shifts % n) + n) % n;
  const nextHandoffMs = anchor + (shifts + 1) * interval;

  return {
    onCall: { name: ordered[index].name, contact: ordered[index].contact },
    source: 'rotation', index,
    nextHandoffMs, overrideEndsMs: null,
  };
}
