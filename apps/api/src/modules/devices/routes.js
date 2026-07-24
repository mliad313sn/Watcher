/** Device inventory CRUD + topology graph for the map view. */

const deviceBody = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 255 },
    address: { type: 'string' },
    kind: { type: 'string' },
    vendor: { type: 'string' },
    model: { type: 'string' },
    os: { type: 'string' },
    location: { type: 'string' },
    parentId: { type: 'string', format: 'uuid', nullable: true },
    tags: { type: 'object' },
    monitored: { type: 'boolean' },
  },
};

export default async function deviceRoutes(fastify) {
  fastify.get('/', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          q: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
    preHandler: fastify.requireRole('viewer'),
  }, async (request) => {
    const { kind, q, limit, offset } = request.query;
    const where = ['tenant_id = $1'];
    const params = [request.user.tenantId];
    if (kind) { params.push(kind); where.push(`kind = $${params.length}`); }
    if (q) { params.push(`%${q}%`); where.push(`(name ILIKE $${params.length} OR host(address)::text ILIKE $${params.length})`); }
    params.push(limit, offset);
    const { rows } = await fastify.pg.query(
      `SELECT * FROM devices WHERE ${where.join(' AND ')}
       ORDER BY name LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { devices: rows };
  });

  fastify.get('/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
    preHandler: fastify.requireRole('viewer'),
  }, async (request, reply) => {
    const { rows } = await fastify.pg.query(
      'SELECT * FROM devices WHERE id = $1 AND tenant_id = $2',
      [request.params.id, request.user.tenantId],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });

    const assignments = await fastify.pg.query(
      'SELECT * FROM poll_assignments WHERE device_id = $1', [request.params.id]);
    return { device: rows[0], pollAssignments: assignments.rows };
  });

  fastify.post('/', { schema: { body: deviceBody }, preHandler: fastify.requireRole('operator') },
    async (request, reply) => {
      const b = request.body;
      const { rows } = await fastify.pg.query(
        `INSERT INTO devices (tenant_id, name, address, kind, vendor, model, os, location, parent_id, tags, monitored)
         VALUES ($1, $2, $3, COALESCE($4, 'other')::device_kind, $5, $6, $7, $8, $9, COALESCE($10, '{}'::jsonb), COALESCE($11, true))
         RETURNING *`,
        [request.user.tenantId, b.name, b.address ?? null, b.kind ?? null, b.vendor ?? null,
         b.model ?? null, b.os ?? null, b.location ?? null, b.parentId ?? null,
         b.tags ? JSON.stringify(b.tags) : null, b.monitored],
      );
      return reply.code(201).send({ device: rows[0] });
    });

  fastify.put('/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: deviceBody,
    },
    preHandler: fastify.requireRole('operator'),
  }, async (request, reply) => {
    const b = request.body;
    const { rows } = await fastify.pg.query(
      `UPDATE devices SET
         name = $3, address = $4, kind = COALESCE($5, kind)::device_kind, vendor = $6,
         model = $7, os = $8, location = $9, parent_id = $10,
         tags = COALESCE($11, tags), monitored = COALESCE($12, monitored)
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [request.params.id, request.user.tenantId, b.name, b.address ?? null, b.kind ?? null,
       b.vendor ?? null, b.model ?? null, b.os ?? null, b.location ?? null, b.parentId ?? null,
       b.tags ? JSON.stringify(b.tags) : null, b.monitored],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    return { device: rows[0] };
  });

  fastify.delete('/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
    preHandler: fastify.requireRole('admin'),
  }, async (request, reply) => {
    const { rowCount } = await fastify.pg.query(
      'DELETE FROM devices WHERE id = $1 AND tenant_id = $2',
      [request.params.id, request.user.tenantId],
    );
    if (rowCount === 0) return reply.code(404).send({ error: 'not found' });
    return reply.code(204).send();
  });

  /** Nodes + edges for the topology map page. */
  fastify.get('/topology/graph', { preHandler: fastify.requireRole('viewer') },
    async (request) => {
      const [nodes, links] = await Promise.all([
        fastify.pg.query(
          'SELECT id, name, kind, address, parent_id, location FROM devices WHERE tenant_id = $1 AND monitored',
          [request.user.tenantId]),
        fastify.pg.query(
          `SELECT a_device_id, a_ifname, b_device_id, b_ifname, layer, source, last_seen
           FROM topology_links WHERE tenant_id = $1`,
          [request.user.tenantId]),
      ]);
      return { nodes: nodes.rows, links: links.rows };
    });
}
