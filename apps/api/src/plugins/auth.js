/**
 * Auth plugin: JWT verification + role-based access control.
 *
 * Usage on a route:
 *   preHandler: fastify.requireRole('operator')
 *
 * Roles are ordered: admin > operator > viewer. A route guarded with
 * 'operator' accepts operators and admins.
 */
import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';

const ROLE_WEIGHT = { viewer: 1, operator: 2, admin: 3 };

export default fp(async function authPlugin(fastify, opts) {
  await fastify.register(jwt, {
    secret: opts.secret,
    sign: { expiresIn: opts.ttl },
  });

  fastify.decorate('authenticate', async function authenticate(request, reply) {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  fastify.decorate('requireRole', function requireRole(minRole) {
    const need = ROLE_WEIGHT[minRole] ?? Infinity;
    return async function roleGuard(request, reply) {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const have = ROLE_WEIGHT[request.user?.role] ?? 0;
      if (have < need) {
        return reply.code(403).send({ error: 'forbidden', required: minRole });
      }
    };
  });
}, { name: 'watcher-auth' });
