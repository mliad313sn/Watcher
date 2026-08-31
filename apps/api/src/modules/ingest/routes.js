/**
 * Inbound alert ingestion — Watcher as the hub other systems feed INTO.
 *
 *   POST /api/ingest/alertmanager  — native Prometheus Alertmanager webhook
 *   POST /api/ingest/event        — generic event for anything else
 *                                    (Zapier/n8n/Power Automate/scripts)
 *
 * External alerts enter the SAME pipeline as Nagios-born ones: deduped by
 * (tenant, device, check) via alerts_open_dedup_idx, published as 'raised' so
 * the notifier pages (on-call, runbooks, maintenance windows all apply), and
 * resolved when the source says so. Auth: operator role (API token friendly).
 */
import { REDIS_KEYS } from '@watcher/shared';

const SEV_MAP = { critical: 'critical', error: 'critical', page: 'critical',
  warning: 'warning', warn: 'warning', info: 'info', none: 'info' };

export default async function ingestRoutes(fastify) {
  async function raise(tenantId, { device, check, severity, message }) {
    // Link to inventory when the device exists; external names still work.
    const { rows: dev } = await fastify.pg.query(
      'SELECT id FROM devices WHERE name = $1 AND tenant_id = $2', [device, tenantId]);
    try {
      const { rows } = await fastify.pg.query(
        `INSERT INTO alerts (tenant_id, device_id, device_name, check_name, severity, status, message)
         VALUES ($1, $2, $3, $4, $5::alert_severity, 'open', $6)
         RETURNING *`,
        [tenantId, dev[0]?.id ?? null, device, check, severity, message]);
      await fastify.redis.publish(REDIS_KEYS.eventsAlerts,
        JSON.stringify({ action: 'raised', alert: rows[0] })).catch(() => {});
      return 'raised';
    } catch (err) {
      if (err.code === '23505') {
        // Already open — refresh the message and count it as an occurrence.
        await fastify.pg.query(
          `UPDATE alerts SET message = $4, occurrences = occurrences + 1, updated_at = now()
           WHERE tenant_id = $1 AND device_name = $2 AND check_name = $3
             AND status IN ('open','acknowledged','suppressed')`,
          [tenantId, device, check, message]);
        return 'updated';
      }
      throw err;
    }
  }

  async function resolve(tenantId, { device, check }) {
    const { rows } = await fastify.pg.query(
      `UPDATE alerts SET status = 'resolved', resolved_at = now()
       WHERE tenant_id = $1 AND device_name = $2 AND check_name = $3
         AND status IN ('open','acknowledged','suppressed')
       RETURNING *`,
      [tenantId, device, check]);
    for (const alert of rows) {
      await fastify.redis.publish(REDIS_KEYS.eventsAlerts,
        JSON.stringify({ action: 'resolved', alert })).catch(() => {});
    }
    return rows.length ? 'resolved' : 'noop';
  }

  /** Prometheus Alertmanager webhook receiver (webhook_config format v4). */
  fastify.post('/alertmanager', {
    schema: {
      body: {
        type: 'object',
        required: ['alerts'],
        properties: { alerts: { type: 'array', maxItems: 200 } },
      },
    },
    preHandler: fastify.requireRole('operator'),
  }, async (request) => {
    const tenantId = request.user.tenantId;
    const results = { raised: 0, updated: 0, resolved: 0, noop: 0 };
    for (const a of request.body.alerts) {
      const labels = a.labels ?? {};
      const ann = a.annotations ?? {};
      const device = labels.instance?.split(':')[0] || labels.host || labels.node || labels.job || 'external';
      const check = labels.alertname || 'external-alert';
      const evt = {
        device,
        check: `am:${check}`,
        severity: SEV_MAP[String(labels.severity ?? '').toLowerCase()] ?? 'warning',
        message: ann.summary || ann.description || check,
      };
      const outcome = a.status === 'resolved'
        ? await resolve(tenantId, evt)
        : await raise(tenantId, evt);
      results[outcome] = (results[outcome] ?? 0) + 1;
    }
    return { ok: true, ...results };
  });

  /** Generic event ingestion — the universal adapter for automation tools. */
  fastify.post('/event', {
    schema: {
      body: {
        type: 'object',
        required: ['device', 'check', 'message'],
        properties: {
          device: { type: 'string', minLength: 1, maxLength: 200 },
          check: { type: 'string', minLength: 1, maxLength: 200 },
          severity: { type: 'string', enum: ['critical', 'warning', 'info'], default: 'warning' },
          message: { type: 'string', minLength: 1, maxLength: 4000 },
          status: { type: 'string', enum: ['firing', 'resolved'], default: 'firing' },
        },
      },
    },
    preHandler: fastify.requireRole('operator'),
  }, async (request) => {
    const { device, check, severity = 'warning', message, status = 'firing' } = request.body;
    const evt = { device, check: `ext:${check}`, severity, message };
    const outcome = status === 'resolved'
      ? await resolve(request.user.tenantId, evt)
      : await raise(request.user.tenantId, evt);
    return { ok: true, outcome };
  });
}
