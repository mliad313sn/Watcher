/** Dashboard & widget layout persistence (drag-and-drop grid). */

const widgetBody = {
  type: 'object',
  required: ['type'],
  properties: {
    type: { type: 'string', enum: ['gauge', 'heatmap', 'traffic', 'statusgrid', 'eventfeed', 'topn'] },
    title: { type: 'string' },
    gridX: { type: 'integer', minimum: 0, maximum: 11 },
    gridY: { type: 'integer', minimum: 0 },
    gridW: { type: 'integer', minimum: 1, maximum: 12 },
    gridH: { type: 'integer', minimum: 1, maximum: 24 },
    config: { type: 'object' },
  },
};

export default async function dashboardRoutes(fastify) {
  fastify.get('/', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    const { rows } = await fastify.pg.query(
      `SELECT * FROM dashboards
       WHERE tenant_id = $1 AND (shared OR owner_id = $2)
       ORDER BY is_default DESC, name`,
      [request.user.tenantId, request.user.sub],
    );
    return { dashboards: rows };
  });

  fastify.get('/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
    preHandler: fastify.requireRole('viewer'),
  }, async (request, reply) => {
    const { rows } = await fastify.pg.query(
      `SELECT * FROM dashboards WHERE id = $1 AND tenant_id = $2 AND (shared OR owner_id = $3)`,
      [request.params.id, request.user.tenantId, request.user.sub],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    const widgets = await fastify.pg.query(
      'SELECT * FROM dashboard_widgets WHERE dashboard_id = $1 ORDER BY grid_y, grid_x',
      [request.params.id],
    );
    return { dashboard: rows[0], widgets: widgets.rows };
  });

  fastify.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          shared: { type: 'boolean', default: false },
        },
      },
    },
    preHandler: fastify.requireRole('operator'),
  }, async (request, reply) => {
    const { rows } = await fastify.pg.query(
      `INSERT INTO dashboards (tenant_id, owner_id, name, shared)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [request.user.tenantId, request.user.sub, request.body.name, request.body.shared],
    );
    return reply.code(201).send({ dashboard: rows[0] });
  });

  fastify.post('/:id/widgets', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: widgetBody,
    },
    preHandler: fastify.requireRole('operator'),
  }, async (request, reply) => {
    const b = request.body;
    const { rows } = await fastify.pg.query(
      `INSERT INTO dashboard_widgets (dashboard_id, type, title, grid_x, grid_y, grid_w, grid_h, config)
       VALUES ($1, $2, $3, COALESCE($4, 0), COALESCE($5, 0), COALESCE($6, 4), COALESCE($7, 3), COALESCE($8, '{}'::jsonb))
       RETURNING *`,
      [request.params.id, b.type, b.title ?? '', b.gridX, b.gridY, b.gridW, b.gridH,
       b.config ? JSON.stringify(b.config) : null],
    );
    return reply.code(201).send({ widget: rows[0] });
  });

  /** Bulk layout save — one call per drag-and-drop drop event. */
  fastify.put('/:id/layout', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['widgets'],
        properties: {
          widgets: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'gridX', 'gridY', 'gridW', 'gridH'],
              properties: {
                id: { type: 'string', format: 'uuid' },
                gridX: { type: 'integer', minimum: 0, maximum: 11 },
                gridY: { type: 'integer', minimum: 0 },
                gridW: { type: 'integer', minimum: 1, maximum: 12 },
                gridH: { type: 'integer', minimum: 1, maximum: 24 },
              },
            },
          },
        },
      },
    },
    preHandler: fastify.requireRole('operator'),
  }, async (request) => {
    const client = await fastify.pg.connect();
    try {
      await client.query('BEGIN');
      for (const w of request.body.widgets) {
        await client.query(
          `UPDATE dashboard_widgets SET grid_x = $2, grid_y = $3, grid_w = $4, grid_h = $5
           WHERE id = $1 AND dashboard_id = $6`,
          [w.id, w.gridX, w.gridY, w.gridW, w.gridH, request.params.id],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return { ok: true };
  });

  fastify.delete('/:id/widgets/:widgetId', {
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          widgetId: { type: 'string', format: 'uuid' },
        },
      },
    },
    preHandler: fastify.requireRole('operator'),
  }, async (request, reply) => {
    await fastify.pg.query(
      'DELETE FROM dashboard_widgets WHERE id = $1 AND dashboard_id = $2',
      [request.params.widgetId, request.params.id],
    );
    return reply.code(204).send();
  });
}
