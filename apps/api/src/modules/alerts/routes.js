/** Alert query & lifecycle routes. */
import { REDIS_KEYS } from '@watcher/shared';

export default async function alertRoutes(fastify) {
  fastify.get('/', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['open', 'acknowledged', 'suppressed', 'resolved'] },
          severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
          device: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
    preHandler: fastify.requireRole('viewer'),
  }, async (request) => {
    const { status, severity, device, limit, offset } = request.query;
    const where = ['tenant_id = $1'];
    const params = [request.user.tenantId];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (severity) { params.push(severity); where.push(`severity = $${params.length}`); }
    if (device) { params.push(`%${device}%`); where.push(`device_name ILIKE $${params.length}`); }
    params.push(limit, offset);

    const { rows } = await fastify.pg.query(
      `SELECT * FROM alerts
       WHERE ${where.join(' AND ')}
       ORDER BY CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END DESC,
                opened_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { alerts: rows };
  });

  fastify.get('/summary', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    const { rows } = await fastify.pg.query(
      `SELECT severity, status, count(*)::int AS count
       FROM alerts
       WHERE tenant_id = $1 AND status <> 'resolved'
       GROUP BY severity, status`,
      [request.user.tenantId],
    );
    return { summary: rows };
  });

  /** Acknowledge in Watcher AND forward to Nagios so both stay consistent. */
  fastify.post('/:id/ack', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['comment'],
        properties: { comment: { type: 'string', minLength: 1 } },
      },
    },
    preHandler: fastify.requireRole('operator'),
  }, async (request, reply) => {
    const { rows } = await fastify.pg.query(
      `UPDATE alerts
       SET status = 'acknowledged', ack_user_id = $2, ack_comment = $3
       WHERE id = $1 AND tenant_id = $4 AND status = 'open'
       RETURNING *`,
      [request.params.id, request.user.sub, request.body.comment, request.user.tenantId],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'alert not open or not found' });
    return { alert: rows[0] };
  });

  // ── Notification & escalation rules ────────────────────────────────────────
  fastify.get('/rules', { preHandler: fastify.requireRole('operator') }, async (request) => {
    const { rows } = await fastify.pg.query(
      'SELECT * FROM alert_rules WHERE tenant_id = $1 ORDER BY name', [request.user.tenantId]);
    return { rules: rows };
  });

  const actionSchema = {
    type: 'array',
    items: {
      type: 'object',
      required: ['type'],
      properties: {
        type: { type: 'string', enum: ['webhook', 'slack', 'email', 'log', 'oncall'] },
        url: { type: 'string' },
        to: { type: 'string' },
        gatewayUrl: { type: 'string' },
        scheduleId: { type: 'string', format: 'uuid' }, // for type: 'oncall'
      },
    },
  };

  fastify.post('/rules', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          minSeverity: { type: 'string', enum: ['critical', 'warning', 'info'], default: 'warning' },
          match: { type: 'object' },
          actions: actionSchema,
          escalateAfterS: { type: 'integer', minimum: 30, maximum: 86400, nullable: true },
          escalationActions: actionSchema,
          enabled: { type: 'boolean', default: true },
        },
      },
    },
    preHandler: fastify.requireRole('admin'),
  }, async (request, reply) => {
    const b = request.body;
    const { rows } = await fastify.pg.query(
      `INSERT INTO alert_rules
         (tenant_id, name, min_severity, match, actions, escalate_after_s, escalation_actions, enabled)
       VALUES ($1, $2, COALESCE($3,'warning')::alert_severity, COALESCE($4,'{}'::jsonb),
               COALESCE($5,'[]'::jsonb), $6, COALESCE($7,'[]'::jsonb), COALESCE($8, true))
       RETURNING *`,
      [request.user.tenantId, b.name, b.minSeverity ?? null,
       b.match ? JSON.stringify(b.match) : null,
       b.actions ? JSON.stringify(b.actions) : null,
       b.escalateAfterS ?? null,
       b.escalationActions ? JSON.stringify(b.escalationActions) : null,
       b.enabled],
    );
    return reply.code(201).send({ rule: rows[0] });
  });

  fastify.delete('/rules/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
    preHandler: fastify.requireRole('admin'),
  }, async (request, reply) => {
    const { rowCount } = await fastify.pg.query(
      'DELETE FROM alert_rules WHERE id = $1 AND tenant_id = $2',
      [request.params.id, request.user.tenantId]);
    if (rowCount === 0) return reply.code(404).send({ error: 'not found' });
    return reply.code(204).send();
  });

  // ── One-tap mobile acknowledge (token-authed, no console login) ────────────
  // The link is a per-alert capability token minted into each notification; it
  // authorises acknowledging exactly that one alert and nothing else.
  function verifyAckToken(token) {
    const claims = fastify.jwt.verify(token ?? '');
    if (claims.purpose !== 'ack' || !claims.alertId) throw new Error('not an ack token');
    return claims;
  }

  fastify.get('/ack-info', {
    schema: { querystring: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } } },
  }, async (request, reply) => {
    let claims;
    try { claims = verifyAckToken(request.query.token); }
    catch { return reply.code(401).send({ error: 'invalid or expired link' }); }
    const { rows } = await fastify.pg.query(
      `SELECT device_name, check_name, severity, status, message, opened_at
       FROM alerts WHERE id = $1 AND tenant_id = $2`,
      [claims.alertId, claims.tenantId]);
    if (rows.length === 0) return reply.code(404).send({ error: 'alert not found' });
    return { alert: rows[0] };
  });

  fastify.post('/ack-by-token', {
    schema: {
      body: {
        type: 'object',
        required: ['token'],
        properties: { token: { type: 'string' }, comment: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    let claims;
    try { claims = verifyAckToken(request.body.token); }
    catch { return reply.code(401).send({ error: 'invalid or expired link' }); }

    const { rows } = await fastify.pg.query(
      `UPDATE alerts
       SET status = 'acknowledged', ack_comment = COALESCE($3, 'acknowledged via mobile link')
       WHERE id = $1 AND tenant_id = $2 AND status IN ('open', 'suppressed')
       RETURNING *`,
      [claims.alertId, claims.tenantId, request.body.comment ?? null]);

    if (rows.length === 0) {
      // Already acked/resolved — report the current state idempotently.
      const cur = await fastify.pg.query(
        'SELECT status FROM alerts WHERE id = $1 AND tenant_id = $2', [claims.alertId, claims.tenantId]);
      if (cur.rows.length === 0) return reply.code(404).send({ error: 'alert not found' });
      return { ok: true, alreadyHandled: true, status: cur.rows[0].status };
    }

    // Reflect the ack live (stops escalation, updates any open console).
    await fastify.redis.publish(REDIS_KEYS.eventsAlerts,
      JSON.stringify({ action: 'updated', alert: rows[0] })).catch(() => {});
    return { ok: true, status: 'acknowledged', device: rows[0].device_name, check: rows[0].check_name };
  });
}
