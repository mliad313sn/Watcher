/**
 * The sweeper that closes event-born alerts.
 *
 * A trap says a thing happened. Nothing ever says it stopped happening, so
 * an alert raised from one has no natural end — and an alert with no end is
 * how a console fills with rows nobody reads, which is the failure mode that
 * makes people stop trusting monitoring altogether.
 *
 * A raising rule therefore carries a deadline (or a paired clearing rule).
 * This resolves whatever has reached its deadline, through the same
 * `watcher:events:alerts` publication the correlation engine uses, so the
 * console, the notifier and the status page all see the close.
 *
 * The deadline is refreshed every time the same event recurs, so a condition
 * that is still happening keeps its alert open; the clock measures silence
 * from the device, not age of the alert.
 */
import { REDIS_KEYS } from '@watcher/shared';

export class AutoClearSweeper {
  constructor({ pg, redis, log, intervalMs = 30_000 }) {
    this.pg = pg;
    this.redis = redis;
    this.log = log;
    this.intervalMs = intervalMs;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(
      () => this.sweep().catch((err) => this.log.error({ err }, 'auto-clear sweep failed')),
      this.intervalMs);
    this.timer.unref();
    this.log.info({ everyMs: this.intervalMs }, 'event auto-clear sweeper started');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Resolve everything due. One statement: the delete and the update happen
   * together, so a sweep that dies half way cannot leave an alert closed
   * with its deadline still armed, or a deadline pointing at nothing.
   */
  async sweep(now = new Date()) {
    const { rows } = await this.pg.query(
      `WITH due AS (
         DELETE FROM alert_auto_clear
          WHERE clear_at <= $1
          RETURNING alert_id
       )
       UPDATE alerts a
          SET status = 'resolved', resolved_at = now()
         FROM due
        WHERE a.id = due.alert_id
          AND a.status IN ('open','acknowledged','suppressed')
        RETURNING a.*`,
      [now]);

    for (const alert of rows) {
      await this.redis.publish(REDIS_KEYS.eventsAlerts,
        JSON.stringify({ action: 'resolved', alert, reason: 'auto-clear' })).catch(() => {});
    }
    if (rows.length) this.log.info({ closed: rows.length }, 'event alerts auto-cleared');
    return rows.length;
  }
}
