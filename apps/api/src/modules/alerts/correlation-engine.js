/**
 * Alert correlation engine.
 *
 * Consumes the raw state stream (watcher:events:state) and produces a curated
 * alert stream designed to prevent alert fatigue:
 *
 *  severity   Nagios states → critical / warning / info (see @watcher/shared).
 *  dedup      one open alert per (device, check); repeat events bump
 *             `occurrences` instead of creating new rows.
 *  deps       if a device's ancestor (devices.parent_id chain) has an open
 *             critical host alert, new child alerts are born SUPPRESSED and
 *             linked to the root cause — the NOC sees one page, not fifty.
 *  flapping   Nagios's own flap detection is honored: flapping objects get a
 *             single 'flapping' alert instead of a stream of transitions.
 *  clear      healthy hard states resolve any open alert for the object, and
 *             resolving a parent's alert un-suppresses its children so
 *             anything still broken independently re-raises visibly.
 *
 * Every mutation is published to watcher:events:alerts for live UIs.
 */
import { REDIS_KEYS, severityFor, stateName } from '@watcher/shared';

export class CorrelationEngine {
  /**
   * @param {object} deps
   * @param {import('ioredis').Redis} deps.redis     command connection
   * @param {import('ioredis').Redis} deps.redisSub  subscriber connection
   * @param {import('pg').Pool} deps.pg              config-plane pool
   * @param {object} deps.log
   */
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
      this.processEvent(JSON.parse(message))
        .catch((err) => this.log.error({ err }, 'alert correlation failed'));
    };
    this.redisSub.on('message', this.handler);
    this.log.info('alert correlation engine started');
  }

  async stop() {
    if (this.handler) this.redisSub.off('message', this.handler);
  }

  /** @param {object} event normalized state-change event from the streamer */
  async processEvent(event) {
    // Soft states are Nagios retries in progress — never alert on them.
    if (!event.hard) return;

    const isHost = event.kind === 'host';
    const severity = severityFor(isHost, event.state);

    if (severity === null) {
      await this.#resolve(event);
      return;
    }
    await this.#raise(event, severity, isHost);
  }

  async #raise(event, severity, isHost) {
    const device = await this.#lookupDevice(event.host);
    const tenantId = device?.tenant_id ?? (await this.#defaultTenant());
    const rootCause = device ? await this.#findRootCause(device) : null;

    const status = rootCause ? 'suppressed' : 'open';
    const message = event.flapping
      ? `${event.host}${event.service ? '/' + event.service : ''} is flapping`
      : `${stateName(isHost, event.state)}: ${event.output || '(no output)'}`;

    // Dedup upsert against the partial unique index on open-ish alerts.
    const { rows } = await this.pg.query(
      `INSERT INTO alerts (tenant_id, device_id, device_name, check_name,
                           severity, status, message, flapping, suppressed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, device_name, check_name)
         WHERE status IN ('open', 'acknowledged', 'suppressed')
       DO UPDATE SET
         severity    = EXCLUDED.severity,
         message     = EXCLUDED.message,
         flapping    = EXCLUDED.flapping,
         occurrences = alerts.occurrences + 1,
         updated_at  = now()
       RETURNING *`,
      [tenantId, device?.id ?? null, event.host, event.service ?? '',
       severity, status, message, event.flapping ?? false, rootCause],
    );

    await this.#publish(rows[0].occurrences > 1 ? 'updated' : 'raised', rows[0]);
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
   * Walk up the parent chain looking for an open critical *host* alert.
   * Returns the id of the closest ancestor alert, or null. Depth-capped to
   * survive accidental cycles in the inventory.
   */
  async #findRootCause(device) {
    let parentId = device.parent_id;
    for (let depth = 0; parentId && depth < 16; depth++) {
      const { rows } = await this.pg.query(
        `SELECT d.id, d.parent_id, d.name,
                a.id AS alert_id
         FROM devices d
         LEFT JOIN alerts a
           ON a.device_id = d.id AND a.check_name = ''
          AND a.severity = 'critical' AND a.status IN ('open', 'acknowledged')
         WHERE d.id = $1`,
        [parentId],
      );
      if (rows.length === 0) return null;
      if (rows[0].alert_id) return rows[0].alert_id;
      parentId = rows[0].parent_id;
    }
    return null;
  }

  /** When a root cause clears, surface whatever it was masking. */
  async #unsuppressChildren(alertId) {
    const { rows } = await this.pg.query(
      `UPDATE alerts
       SET status = 'open', suppressed_by = NULL
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
        "SELECT id FROM tenants ORDER BY created_at LIMIT 1");
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
