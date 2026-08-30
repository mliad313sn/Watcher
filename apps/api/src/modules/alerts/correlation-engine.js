/**
 * Alert correlation engine.
 *
 * Consumes the raw state stream (watcher:events:state) and produces a curated
 * alert stream designed to prevent alert fatigue:
 *
 *  severity     Nagios states → critical / warning / info (see @watcher/shared).
 *  downtime     objects in a Nagios scheduled-downtime window are recorded but
 *               kept `suppressed` and never dispatched (issue #1).
 *  ack          objects acknowledged in Nagios open as `acknowledged` and stay
 *               that way unless they escalate (issue #1).
 *  dedup        one open alert per (device, check); repeat events bump
 *               `occurrences` instead of creating new rows.
 *  deps         children of a device with an open critical host alert are born
 *               (or become) suppressed and linked to the root cause. Suppression
 *               is applied in BOTH directions — when a child alerts first and its
 *               parent fails later, the parent's alert retro-suppresses the
 *               already-open children (fixes the ordering race, issue M3).
 *  escalation   an acknowledged alert that escalates in severity re-opens so it
 *               pages again (issue M3).
 *  flapping     Nagios flap state is honoured, and a very recently resolved
 *               alert that re-fires is re-opened + flagged flapping instead of
 *               spawning a fresh row (damps sub-threshold flap churn, issue M3).
 *  clear        healthy hard states resolve open alerts; resolving a root cause
 *               un-suppresses its children so anything still broken re-surfaces.
 *
 * Every mutation is published to watcher:events:alerts for live UIs + notifier.
 */
import { REDIS_KEYS, severityFor, stateName, SEVERITY_WEIGHT } from '@watcher/shared';

const FLAP_REOPEN_WINDOW_MS = 5 * 60 * 1000;

export class CorrelationEngine {
  constructor({ redis, redisSub, pg, log }) {
    this.redis = redis;
    this.redisSub = redisSub;
    this.pg = pg;
    this.log = log;
    this.handler = null;
  }

  async start() {
    await this.redisSub.subscribe(REDIS_KEYS.eventsState);
    this.handler = (channel, message) => {
      if (channel !== REDIS_KEYS.eventsState) return;
      let event;
      try { event = JSON.parse(message); }
      catch { this.log.warn('dropped malformed state event on bus'); return; }
      this.processEvent(event)
        .catch((err) => this.log.error({ err }, 'alert correlation failed'));
    };
    this.redisSub.on('message', this.handler);
    this.log.info('alert correlation engine started');
  }

  async stop() {
    if (this.handler) this.redisSub.off('message', this.handler);
  }

  async processEvent(event) {
    if (!event.hard) return; // soft states are Nagios retries — never alert

    const isHost = event.kind === 'host';
    const severity = severityFor(isHost, event.state);

    if (severity === null) {
      await this.#resolve(event);
      return;
    }
    await this.#raise(event, severity, isHost);
  }

  async #raise(event, severity, isHost, retried = false) {
    const device = await this.#lookupDevice(event.host);
    const tenantId = device?.tenant_id ?? event.tenantId ?? (await this.#defaultTenant());
    const checkName = event.service ?? '';

    // Decide the alert's status. Precedence: dependency suppression, then
    // scheduled downtime, then Nagios ack, else open+actionable.
    const rootCause = device ? await this.#findRootCause(device) : null;
    let status = 'open';
    if (rootCause) status = 'suppressed';
    else if (event.inDowntime) status = 'suppressed';
    else if (event.acknowledged) status = 'acknowledged';

    const message = event.flapping
      ? `${event.host}${checkName ? '/' + checkName : ''} is flapping`
      : `${stateName(isHost, event.state)}: ${event.output || '(no output)'}`;

    // Is there already an open-ish alert for this (device, check)?
    const existing = await this.pg.query(
      `SELECT id, severity, status FROM alerts
       WHERE tenant_id = $1 AND device_name = $2 AND check_name = $3
         AND status IN ('open', 'acknowledged', 'suppressed')
       LIMIT 1`,
      [tenantId, event.host, checkName],
    );

    let alert;
    if (existing.rows.length) {
      const cur = existing.rows[0];
      // Escalation: an acknowledged (or suppressed-by-downtime) alert whose
      // severity increases re-opens so it pages again.
      const escalated = SEVERITY_WEIGHT[severity] > SEVERITY_WEIGHT[cur.severity];
      let newStatus = cur.status;
      if (rootCause) newStatus = 'suppressed';
      else if (cur.status === 'acknowledged' && escalated) newStatus = 'open';
      else if (cur.status === 'suppressed' && !event.inDowntime && !rootCause) newStatus = 'open';

      const { rows } = await this.pg.query(
        `UPDATE alerts SET severity = $2, message = $3, flapping = $4, status = $5,
                          suppressed_by = $6, occurrences = occurrences + 1, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [cur.id, severity, message, event.flapping ?? false, newStatus, rootCause],
      );
      alert = rows[0];
      await this.#publish(escalated && newStatus === 'open' ? 'escalated' : 'updated', alert);
    } else {
      // Flap damping: reuse a very-recently-resolved row instead of a new one.
      const recent = await this.pg.query(
        `SELECT id FROM alerts
         WHERE tenant_id = $1 AND device_name = $2 AND check_name = $3 AND status = 'resolved'
           AND resolved_at > now() - ($4::int * INTERVAL '1 millisecond')
         ORDER BY resolved_at DESC LIMIT 1`,
        [tenantId, event.host, checkName, FLAP_REOPEN_WINDOW_MS],
      );

      if (recent.rows.length) {
        const { rows } = await this.pg.query(
          `UPDATE alerts SET severity = $2, message = $3, flapping = true, status = $4,
                            suppressed_by = $5, occurrences = occurrences + 1,
                            resolved_at = NULL, updated_at = now()
           WHERE id = $1 RETURNING *`,
          [recent.rows[0].id, severity, message, status, rootCause],
        );
        alert = rows[0];
        await this.#publish('raised', alert);
      } else {
        try {
          const { rows } = await this.pg.query(
            `INSERT INTO alerts (tenant_id, device_id, device_name, check_name,
                                 severity, status, message, flapping, suppressed_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [tenantId, device?.id ?? null, event.host, checkName,
             severity, status, message, event.flapping ?? false, rootCause],
          );
          alert = rows[0];
          await this.#publish('raised', alert);
        } catch (err) {
          // Race: a concurrent event opened the same (device, check) alert
          // between our SELECT and INSERT and tripped the partial-unique
          // index. Re-run once — the retry now takes the UPDATE branch.
          if (err.code === '23505' && !retried) {
            return this.#raise(event, severity, isHost, true);
          }
          throw err;
        }
      }
    }

    // If THIS is a newly-open critical host alert, retro-suppress any children
    // that alerted before their parent failed (closes the ordering race).
    if (isHost && severity === 'critical' && alert.status === 'open' && device) {
      await this.#suppressDescendants(device.id, alert.id);
    }
  }

  async #resolve(event) {
    const { rows } = await this.pg.query(
      `UPDATE alerts
       SET status = 'resolved', resolved_at = now()
       WHERE device_name = $1 AND check_name = $2
         AND status IN ('open', 'acknowledged', 'suppressed')
       RETURNING *`,
      [event.host, event.service ?? ''],
    );
    for (const alert of rows) {
      await this.#publish('resolved', alert);
      await this.#unsuppressChildren(alert.id);
    }
  }

  /**
   * Closest ancestor with an open critical *host* alert, via a single
   * recursive CTE (replaces the per-hop query loop).
   */
  async #findRootCause(device) {
    const { rows } = await this.pg.query(
      `WITH RECURSIVE ancestors AS (
         SELECT id, parent_id, 0 AS depth FROM devices WHERE id = $1
         UNION ALL
         SELECT d.id, d.parent_id, a.depth + 1
         FROM devices d JOIN ancestors a ON d.id = a.parent_id
         WHERE a.depth < 16
       )
       SELECT al.id AS alert_id
       FROM ancestors an
       JOIN alerts al ON al.device_id = an.id AND al.check_name = ''
        AND al.severity = 'critical' AND al.status IN ('open', 'acknowledged')
       WHERE an.depth > 0
       ORDER BY an.depth ASC
       LIMIT 1`,
      [device.id],
    );
    return rows[0]?.alert_id ?? null;
  }

  /** Suppress open alerts on all descendant devices under a failed parent. */
  async #suppressDescendants(deviceId, rootAlertId) {
    const { rows } = await this.pg.query(
      `WITH RECURSIVE descendants AS (
         SELECT id FROM devices WHERE id = $1
         UNION ALL
         SELECT d.id FROM devices d JOIN descendants ds ON d.parent_id = ds.id
       )
       UPDATE alerts SET status = 'suppressed', suppressed_by = $2, updated_at = now()
       WHERE device_id IN (SELECT id FROM descendants WHERE id <> $1)
         AND status = 'open'
       RETURNING *`,
      [deviceId, rootAlertId],
    );
    for (const alert of rows) await this.#publish('suppressed', alert);
  }

  /** When a root cause clears, surface whatever it was masking. */
  async #unsuppressChildren(alertId) {
    const { rows } = await this.pg.query(
      `UPDATE alerts
       SET status = 'open', suppressed_by = NULL, updated_at = now()
       WHERE suppressed_by = $1 AND status = 'suppressed'
       RETURNING *`,
      [alertId],
    );
    for (const alert of rows) await this.#publish('unsuppressed', alert);
  }

  async #lookupDevice(name) {
    const { rows } = await this.pg.query(
      'SELECT id, tenant_id, parent_id, name FROM devices WHERE name = $1 LIMIT 1',
      [name],
    );
    return rows[0] ?? null;
  }

  async #defaultTenant() {
    if (!this._defaultTenantId) {
      const { rows } = await this.pg.query(
        'SELECT id FROM tenants ORDER BY created_at LIMIT 1');
      this._defaultTenantId = rows[0]?.id;
    }
    return this._defaultTenantId;
  }

  async #publish(action, alert) {
    await this.redis.publish(
      REDIS_KEYS.eventsAlerts,
      JSON.stringify({ action, alert }),
    );
  }
}
