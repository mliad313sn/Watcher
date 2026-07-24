/** Login + session info + user management (admin). */
import { hashPassword, verifyPassword } from './password.js';

export default async function authRoutes(fastify) {
  fastify.post('/login', {
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', minLength: 1 },
          password: { type: 'string', minLength: 1 },
          tenant: { type: 'string', default: 'default' },
        },
      },
    },
  }, async (request, reply) => {
    const { username, password, tenant } = request.body;
    const { rows } = await fastify.pg.query(
      `SELECT u.id, u.username, u.display_name, u.role, u.password_hash, u.disabled,
              t.id AS tenant_id, t.name AS tenant_name
       FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.username = $1 AND t.name = $2`,
      [username, tenant],
    );
    const user = rows[0];
    const ok = user && !user.disabled && await verifyPassword(password, user.password_hash);
    if (!ok) {
      // Uniform error → no username enumeration.
      return reply.code(401).send({ error: 'invalid credentials' });
    }

    const token = fastify.jwt.sign({
      sub: user.id,
      username: user.username,
      role: user.role,
      tenantId: user.tenant_id,
      tenant: user.tenant_name,
    });
    return {
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        tenant: user.tenant_name,
      },
    };
  });

  fastify.get('/me', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    return { user: request.user };
  });

  fastify.post('/users', {
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password', 'role'],
        properties: {
          username: { type: 'string', minLength: 1, maxLength: 64 },
          password: { type: 'string', minLength: 8 },
          displayName: { type: 'string' },
          email: { type: 'string', format: 'email' },
          role: { type: 'string', enum: ['admin', 'operator', 'viewer'] },
        },
      },
    },
    preHandler: fastify.requireRole('admin'),
  }, async (request, reply) => {
    const b = request.body;
    const passwordHash = await hashPassword(b.password);
    const { rows } = await fastify.pg.query(
      `INSERT INTO users (tenant_id, username, display_name, email, role, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, username, display_name, email, role, created_at`,
      [request.user.tenantId, b.username, b.displayName ?? b.username, b.email ?? null, b.role, passwordHash],
    );
    return reply.code(201).send({ user: rows[0] });
  });
}
