/**
 * On-call persistence helpers shared by the API routes and the notifier's
 * `oncall` dispatch adapter. Keeps the resolver fed with DB rows.
 */
import { whoIsOnCall } from './resolver.js';

/** Load a schedule with its participants + currently-relevant overrides. */
export async function loadSchedule(pg, scheduleId, tenantId) {
  const sched = await pg.query(
    `SELECT id, name, timezone, rotation_interval_s, handoff_at
     FROM oncall_schedules WHERE id = $1 ${tenantId ? 'AND tenant_id = $2' : ''}`,
    tenantId ? [scheduleId, tenantId] : [scheduleId]);
  if (sched.rows.length === 0) return null;

  const [parts, overs] = await Promise.all([
    pg.query('SELECT position, name, contact FROM oncall_participants WHERE schedule_id = $1 ORDER BY position', [scheduleId]),
    pg.query(`SELECT name, contact, starts_at, ends_at FROM oncall_overrides
              WHERE schedule_id = $1 AND ends_at > now() - interval '1 day'`, [scheduleId]),
  ]);
  return { schedule: sched.rows[0], participants: parts.rows, overrides: overs.rows };
}

/** Resolve who is on call for a schedule right now (or null). */
export async function currentOnCall(pg, scheduleId, tenantId, nowMs = Date.now()) {
  const loaded = await loadSchedule(pg, scheduleId, tenantId);
  if (!loaded) return null;
  return whoIsOnCall({
    schedule: {
      handoffAt: loaded.schedule.handoff_at,
      rotationIntervalS: loaded.schedule.rotation_interval_s,
    },
    participants: loaded.participants,
    overrides: loaded.overrides.map((o) => ({ name: o.name, contact: o.contact, startsAt: o.starts_at, endsAt: o.ends_at })),
    nowMs,
  });
}
