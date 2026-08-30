/** On-call schedules, rotations, overrides + "who's on now". */
import { currentOnCall, loadSchedule } from './store.js';

const contactSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['webhook', 'slack', 'email', 'log'] },
    url: { type: 'string' },
    to: { type: 'string' },
    gatewayUrl: { type: 'string' },
  },
};

export default async function oncallRoutes(fastify) {
  /** All schedules for the tenant, each with its current on-call resolved. */
  fastify.get('/schedules', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    const { rows } = await fastify.pg.query(
      'SELECT * FROM oncall_schedules WHERE tenant_id = $1 ORDER BY name', [request.user.tenantId]);
    const schedules = [];
    for (const s of rows) {
      const current = await currentOnCall(fastify.pg, s.id, request.user.tenantId);
      const parts = await fastify.pg.query(
        'SELECT position, name, contact FROM oncall_participants WHERE schedule_id = $1 ORDER BY position', [s.id]);
      schedules.push({ ...s, current, participants: parts.rows });
    }
    return { schedules };
  });

  /** Who is on call for one schedule right now (for widgets / integrations). */
  fastify.get('/schedules/:id/current', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
    preHandler: fastify.requireRole('viewer'),
  }, async (request, reply) => {
    const current = await currentOnCall(fastify.pg, request.params.id, request.user.tenantId);
    if (!current) return reply.code(404).send({ error: 'schedule not found' });
    return { current };
  });

  fastify.post('/schedules', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'participants'],
        properties: {
          name: { type: 'string', minLength: 1 },
          timezone: { type: 'string' },
          rotationIntervalS: { type: 'integer', minimum: 3600, default: 604800 },
          handoffAt: { type: 'string' },
          participants: {
            type: 'array', minItems: 1,
            items: {
              type: 'object',
              required: ['name'],
              properties: { name: { type: 'string', minLength: 1 }, contact: contactSchema },
            },
          },
        },
      },
    },
    preHandler: fastify.requireRole('admin'),
  }, async (request, reply) => {
    const b = request.body;
    const client = await fastify.pg.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO oncall_schedules (tenant_id, name, timezone, rotation_interval_s, handoff_at)
         VALUES ($1, $2, COALESCE($3,'UTC'), COALESCE($4, 604800), COALESCE($5, now()))
         RETURNING *`,
        [request.user.tenantId, b.name, b.timezone ?? null, b.rotationIntervalS ?? null, b.handoffAt ?? null]);
      const schedule = rows[0];
      for (let i = 0; i < b.participants.length; i++) {
        const p = b.participants[i];
        await client.query(
          `INSERT INTO oncall_participants (schedule_id, position, name, contact)
           VALUES ($1, $2, $3, COALESCE($4,'{}'::jsonb))`,
          [schedule.id, i, p.name, p.contact ? JSON.stringify(p.contact) : null]);
      }
      await client.query('COMMIT');
      return reply.code(201).send({ schedule });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') return reply.code(409).send({ error: 'a schedule with that name exists' });
      throw err;
    } finally {
      client.release();
    }
  });

  fastify.delete('/schedules/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
    preHandler: fastify.requireRole('admin'),
  }, async (request, reply) => {
    const { rowCount } = await fastify.pg.query(
      'DELETE FROM oncall_schedules WHERE id = $1 AND tenant_id = $2',
      [request.params.id, request.user.tenantId]);
    if (rowCount === 0) return reply.code(404).send({ error: 'not found' });
    return reply.code(204).send();
  });

  /** Add a temporary override (cover) to a schedule. */
  fastify.post('/schedules/:id/overrides', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['name', 'startsAt', 'endsAt'],
        properties: {
          name: { type: 'string', minLength: 1 },
          contact: contactSchema,
          startsAt: { type: 'string' },
          endsAt: { type: 'string' },
        },
      },
    },
    preHandler: fastify.requireRole('operator'),
  }, async (request, reply) => {
    // Confirm the schedule is in the caller's tenant before attaching cover.
    if (!(await loadSchedule(fastify.pg, request.params.id, request.user.tenantId))) {
      return reply.code(404).send({ error: 'schedule not found' });
    }
    const b = request.body;
    const { rows } = await fastify.pg.query(
      `INSERT INTO oncall_overrides (schedule_id, name, contact, starts_at, ends_at)
       VALUES ($1, $2, COALESCE($3,'{}'::jsonb), $4, $5) RETURNING *`,
      [request.params.id, b.name, b.contact ? JSON.stringify(b.contact) : null, b.startsAt, b.endsAt]);
    return reply.code(201).send({ override: rows[0] });
  });
}
