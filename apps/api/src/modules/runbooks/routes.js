/** Runbook management + per-alert resolution. */
import { runbookForAlert } from './store.js';

const linksSchema = {
  type: 'array',
  items: {
    type: 'object',
    required: ['label', 'url'],
    properties: { label: { type: 'string' }, url: { type: 'string' } },
  },
};

export default async function runbookRoutes(fastify) {
  fastify.get('/', { preHandler: fastify.requireRole('operator') }, async (request) => {
    const { rows } = await fastify.pg.query(
      'SELECT * FROM runbooks WHERE tenant_id = $1 ORDER BY priority DESC, name', [request.user.tenantId]);
    return { runbooks: rows };
  });

  fastify.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          match: { type: 'object' },
          steps: { type: 'string' },
          links: linksSchema,
          priority: { type: 'integer', minimum: 0, maximum: 1000 },
          enabled: { type: 'boolean' },
        },
      },
    },
    preHandler: fastify.requireRole('admin'),
  }, async (request, reply) => {
    const b = request.body;
    const { rows } = await fastify.pg.query(
      `INSERT INTO runbooks (tenant_id, name, match, steps, links, priority, enabled)
       VALUES ($1, $2, COALESCE($3,'{}'::jsonb), COALESCE($4,''), COALESCE($5,'[]'::jsonb),
               COALESCE($6, 0), COALESCE($7, true))
       ON CONFLICT (tenant_id, name) DO UPDATE SET
         match = EXCLUDED.match, steps = EXCLUDED.steps, links = EXCLUDED.links,
         priority = EXCLUDED.priority, enabled = EXCLUDED.enabled
       RETURNING *`,
      [request.user.tenantId, b.name, b.match ? JSON.stringify(b.match) : null,
       b.steps ?? null, b.links ? JSON.stringify(b.links) : null, b.priority ?? null, b.enabled]);
    return reply.code(201).send({ runbook: rows[0] });
  });

  fastify.delete('/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
    preHandler: fastify.requireRole('admin'),
  }, async (request, reply) => {
    const { rowCount } = await fastify.pg.query(
      'DELETE FROM runbooks WHERE id = $1 AND tenant_id = $2', [request.params.id, request.user.tenantId]);
    if (rowCount === 0) return reply.code(404).send({ error: 'not found' });
    return reply.code(204).send();
  });

  /** The runbook that applies to a given alert (or null). */
  fastify.get('/for-alert/:alertId', {
    schema: { params: { type: 'object', properties: { alertId: { type: 'string', format: 'uuid' } } } },
    preHandler: fastify.requireRole('viewer'),
  }, async (request) => {
    const { rows } = await fastify.pg.query(
      'SELECT * FROM alerts WHERE id = $1 AND tenant_id = $2', [request.params.alertId, request.user.tenantId]);
    if (rows.length === 0) return { runbook: null };
    return { runbook: await runbookForAlert(fastify.pg, rows[0]) };
  });
}
