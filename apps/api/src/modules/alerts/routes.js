/** Alert query & lifecycle routes. */

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
}
