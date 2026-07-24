/** Discovery job management. Execution happens in the poller worker; the API
 *  creates jobs and reports progress. */

export default async function discoveryRoutes(fastify) {
  fastify.get('/jobs', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    const { rows } = await fastify.pg.query(
      'SELECT * FROM discovery_jobs WHERE tenant_id = $1 ORDER BY created_at DESC',
      [request.user.tenantId],
    );
    return { jobs: rows };
  });

  fastify.post('/jobs', {
    schema: {
      body: {
        type: 'object',
        required: ['cidr'],
        properties: {
          cidr: { type: 'string', pattern: '^\\d{1,3}(\\.\\d{1,3}){3}/\\d{1,2}$' },
          protocols: { type: 'array', items: { type: 'string', enum: ['ping', 'snmp'] } },
          credentialIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
          schedule: { type: 'string' },
        },
      },
    },
    preHandler: fastify.requireRole('operator'),
  }, async (request, reply) => {
    const b = request.body;
    const { rows } = await fastify.pg.query(
      `INSERT INTO discovery_jobs (tenant_id, cidr, protocols, credential_ids, schedule)
       VALUES ($1, $2, COALESCE($3, '{ping,snmp}'::poll_protocol[]), COALESCE($4, '{}'), $5)
       RETURNING *`,
      [request.user.tenantId, b.cidr, b.protocols ?? null, b.credentialIds ?? null, b.schedule ?? null],
    );
    // Wake the poller: it watches this queue for jobs to execute.
    await fastify.redis.lpush('watcher:discovery:queue', rows[0].id);
    return reply.code(201).send({ job: rows[0] });
  });
}
