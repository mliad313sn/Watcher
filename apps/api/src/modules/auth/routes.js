/** Login + session info + user management (admin). */
import { REDIS_KEYS } from '@watcher/shared';
import { hashPassword, verifyPassword } from './password.js';

// A real scrypt hash of a random string, used to spend the same CPU verifying a
// login for a non-existent user as for a real one — closes the timing oracle
// that would otherwise let an attacker enumerate usernames.
const DUMMY_HASH =
  'scrypt$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000';

const MAX_ATTEMPTS = 10;
const LOCKOUT_WINDOW_S = 300;

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

    // Brute-force throttle: count failures per (tenant, username) in a window.
    const attemptsKey = REDIS_KEYS.loginAttempts(tenant, username);
    const attempts = Number(await fastify.redis.get(attemptsKey)) || 0;
    if (attempts >= MAX_ATTEMPTS) {
      return reply.code(429).send({ error: 'too many attempts, try again later' });
    }

    const { rows } = await fastify.pg.query(
      `SELECT u.id, u.username, u.display_name, u.role, u.password_hash, u.disabled,
              u.password_change_required,
              t.id AS tenant_id, t.name AS tenant_name
       FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.username = $1 AND t.name = $2`,
      [username, tenant],
    );
    const user = rows[0];
    // Always run a verify (real or dummy) so response time doesn't reveal
    // whether the username exists.
    const valid = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    const ok = Boolean(user) && !user.disabled && valid;

    if (!ok) {
      await fastify.redis
        .multi()
        .incr(attemptsKey)
        .expire(attemptsKey, LOCKOUT_WINDOW_S)
        .exec();
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    await fastify.redis.del(attemptsKey);

    const token = fastify.jwt.sign({
      sub: user.id,
      username: user.username,
      role: user.role,
      tenantId: user.tenant_id,
      tenant: user.tenant_name,
    });
    return {
      token,
      passwordChangeRequired: user.password_change_required,
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

  /** Change own password (clears the forced-change flag). */
  fastify.post('/change-password', {
    schema: {
      body: {
        type: 'object',
        required: ['currentPassword', 'newPassword'],
        properties: {
          currentPassword: { type: 'string', minLength: 1 },
          newPassword: { type: 'string', minLength: 8 },
        },
      },
    },
    preHandler: fastify.requireRole('viewer'),
  }, async (request, reply) => {
    const { currentPassword, newPassword } = request.body;
    const { rows } = await fastify.pg.query(
      'SELECT password_hash FROM users WHERE id = $1', [request.user.sub]);
    if (!rows[0] || !(await verifyPassword(currentPassword, rows[0].password_hash))) {
      return reply.code(401).send({ error: 'current password incorrect' });
    }
    await fastify.pg.query(
      `UPDATE users SET password_hash = $2, password_change_required = false WHERE id = $1`,
      [request.user.sub, await hashPassword(newPassword)],
    );
    return { ok: true };
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
