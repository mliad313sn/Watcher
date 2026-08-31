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
      `SELECT a.*, u.username AS assignee
       FROM alerts a LEFT JOIN users u ON u.id = a.assignee_user_id
       WHERE ${where.map((w) => w.replace(/^(tenant_id|status|severity|device_name)/, 'a.$1')).join(' AND ')}
       ORDER BY CASE a.severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END DESC,
                a.opened_at DESC
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

  /** Claim / release an incident. body.userId omitted = assign to caller;
   *  body.userId null = unassign. The room sees who owns what. */
  fastify.post('/:id/assign', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        properties: { userId: { type: ['string', 'null'] } },
      },
    },
    preHandler: fastify.requireRole('operator'),
  }, async (request, reply) => {
    const hasField = request.body && 'userId' in request.body;
    const target = hasField ? request.body.userId : request.user.sub;
    const { rows } = await fastify.pg.query(
      `UPDATE alerts
       SET assignee_user_id = $2::uuid, assigned_at = CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END
       WHERE id = $1 AND tenant_id = $3 AND status <> 'resolved'
       RETURNING *`,
      [request.params.id, target, request.user.tenantId]);
    if (rows.length === 0) return reply.code(404).send({ error: 'alert not found or resolved' });
    await fastify.redis.publish(REDIS_KEYS.eventsAlerts,
      JSON.stringify({ action: 'updated', alert: rows[0] })).catch(() => {});
    return { alert: rows[0] };
  });

  /** Bulk acknowledge — clear an alert storm in one action. */
  fastify.post('/bulk-ack', {
    schema: {
      body: {
        type: 'object',
        required: ['ids', 'comment'],
        properties: {
          ids: { type: 'array', minItems: 1, maxItems: 200,
                 items: { type: 'string', format: 'uuid' } },
          comment: { type: 'string', minLength: 1 },
        },
      },
    },
    preHandler: fastify.requireRole('operator'),
  }, async (request) => {
    const { ids, comment } = request.body;
    const { rows } = await fastify.pg.query(
      `UPDATE alerts
       SET status = 'acknowledged', ack_user_id = $2, ack_comment = $3
       WHERE id = ANY($1::uuid[]) AND tenant_id = $4 AND status IN ('open', 'suppressed')
       RETURNING *`,
      [ids, request.user.sub, comment, request.user.tenantId]);
    for (const alert of rows) {
      fastify.redis.publish(REDIS_KEYS.eventsAlerts,
        JSON.stringify({ action: 'updated', alert })).catch(() => {});
    }
    return { acknowledged: rows.length, requested: ids.length };
  });

  /** Verify a channel config by sending a synthetic notification through the
   *  real delivery path — admins test Teams/Jira/etc. before relying on them. */
  fastify.post('/test-channel', {
    schema: { body: { type: 'object', required: ['action'], properties: { action: { type: 'object' } } } },
    preHandler: fastify.requireRole('admin'),
  }, async (request, reply) => {
    if (!fastify.notifier) return reply.code(503).send({ error: 'notifier not running on this instance' });
    return fastify.notifier.testChannel(request.body.action);
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
        type: { type: 'string', enum: ['webhook', 'slack', 'teams', 'pagerduty', 'opsgenie',
          'jira', 'servicenow', 'discord', 'telegram', 'googlechat', 'email', 'smtp', 'log', 'oncall'] },
        url: { type: 'string' },
        to: { type: 'string' },
        gatewayUrl: { type: 'string' },
        routingKey: { type: 'string' },  // pagerduty (Events API v2)
        apiKey: { type: 'string' },      // opsgenie
        card: { type: 'string', enum: ['adaptive', 'messagecard'] }, // teams
        projectKey: { type: 'string' },  // jira
        issueType: { type: 'string' },   // jira
        email: { type: 'string' },       // jira basic auth
        apiToken: { type: 'string' },    // jira basic auth
        bearer: { type: 'string' },      // jira PAT
        user: { type: 'string' },        // servicenow basic auth
        password: { type: 'string' },    // servicenow basic auth
        botToken: { type: 'string' },    // telegram
        chatId: { type: 'string' },      // telegram
        smtp: { type: 'object' },        // per-action SMTP override
        scheduleId: { type: 'string', format: 'uuid' }, // oncall
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
