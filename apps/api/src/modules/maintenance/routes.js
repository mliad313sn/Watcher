/**
 * Maintenance windows — planned work that should not page anyone.
 * CRUD (operator+) plus an /active view. Alerts still open and record during
 * a window (history stays honest); the notifier checks windowFor() and
 * suppresses the page instead.
 */

/** Does a device fall inside a window's match? Empty match = everything. */
export function deviceInWindow(match, device) {
  const m = match ?? {};
  if (m.kind && device?.kind !== m.kind) return false;
  if (m.devicePattern) {
    try {
      if (!new RegExp(m.devicePattern).test(device?.name ?? '')) return false;
    } catch { return false; } // a broken regex matches nothing, loudly in review
  }
  return true;
}

export default async function maintenanceRoutes(fastify) {
  fastify.get('/', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    const { rows } = await fastify.pg.query(
      `SELECT mw.*, u.username AS created_by_name,
              (now() BETWEEN mw.starts_at AND mw.ends_at) AS active
       FROM maintenance_windows mw LEFT JOIN users u ON u.id = mw.created_by
       WHERE mw.tenant_id = $1 AND mw.ends_at > now() - interval '7 days'
       ORDER BY mw.starts_at`,
      [request.user.tenantId]);
    return { windows: rows };
  });

  fastify.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'startsAt', 'endsAt'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          startsAt: { type: 'string', format: 'date-time' },
          endsAt: { type: 'string', format: 'date-time' },
          match: {
            type: 'object',
            properties: {
              kind: { type: 'string' },
              devicePattern: { type: 'string', maxLength: 200 },
            },
            additionalProperties: false,
          },
        },
      },
    },
    preHandler: fastify.requireRole('operator'),
  }, async (request, reply) => {
    const { name, startsAt, endsAt, match } = request.body;
    if (new Date(endsAt) <= new Date(startsAt)) {
      return reply.code(400).send({ error: 'endsAt must be after startsAt' });
    }
    if (match?.devicePattern) {
      try { new RegExp(match.devicePattern); }
      catch { return reply.code(400).send({ error: 'devicePattern is not a valid regex' }); }
    }
    const { rows } = await fastify.pg.query(
      `INSERT INTO maintenance_windows (tenant_id, name, starts_at, ends_at, match, created_by)
       VALUES ($1, $2, $3, $4, COALESCE($5, '{}'::jsonb), $6)
       RETURNING *`,
      [request.user.tenantId, name, startsAt, endsAt,
       match ? JSON.stringify(match) : null, request.user.sub]);
    return reply.code(201).send({ window: rows[0] });
  });

  fastify.delete('/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
    preHandler: fastify.requireRole('operator'),
  }, async (request, reply) => {
    const { rowCount } = await fastify.pg.query(
      'DELETE FROM maintenance_windows WHERE id = $1 AND tenant_id = $2',
      [request.params.id, request.user.tenantId]);
    if (rowCount === 0) return reply.code(404).send({ error: 'not found' });
    return reply.code(204).send();
  });
}

/**
 * Notifier hook: the first active window covering this alert's device, or
 * null. Kept here so window-matching logic lives in one module.
 */
export async function activeWindowFor(pg, alert, device) {
  const { rows } = await pg.query(
    `SELECT id, name, ends_at, match FROM maintenance_windows
     WHERE tenant_id = $1 AND now() BETWEEN starts_at AND ends_at
     ORDER BY starts_at`,
    [alert.tenant_id]);
  for (const w of rows) {
    if (deviceInWindow(w.match, device ?? { name: alert.device_name })) return w;
  }
  return null;
}

/** Public status banner: active or next-upcoming (≤7d) window for a tenant. */
export async function publicMaintenanceNotice(pg, tenantId) {
  const { rows } = await pg.query(
    `SELECT name, starts_at, ends_at,
            (now() BETWEEN starts_at AND ends_at) AS active
     FROM maintenance_windows
     WHERE tenant_id = $1 AND ends_at > now() AND starts_at < now() + interval '7 days'
     ORDER BY active DESC, starts_at ASC
     LIMIT 1`,
    [tenantId]);
  return rows[0] ?? null;
}
