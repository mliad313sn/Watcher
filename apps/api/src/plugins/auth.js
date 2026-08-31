/**
 * Auth plugin: JWT verification + role-based access control + API tokens.
 *
 * Usage on a route:
 *   preHandler: fastify.requireRole('operator')
 *
 * Roles are ordered: admin > operator > viewer. A route guarded with
 * 'operator' accepts operators and admins.
 *
 * Two credentials are accepted:
 *   - Authorization: Bearer <jwt>      — interactive sessions
 *   - X-API-Token: <secret>            — automation (scoped, revocable,
 *     stored only as a SHA-256 hash; see api_tokens)
 */
import crypto from 'node:crypto';
import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';

const ROLE_WEIGHT = { viewer: 1, operator: 2, admin: 3 };

export default fp(async function authPlugin(fastify, opts) {
  await fastify.register(jwt, {
    secret: opts.secret,
    sign: { expiresIn: opts.ttl },
  });

  /** Resolve an X-API-Token header into a synthetic request.user, or null. */
  async function apiTokenUser(request) {
    const secret = request.headers['x-api-token'];
    if (!secret || typeof secret !== 'string') return null;
    const hash = crypto.createHash('sha256').update(secret).digest('hex');
    const { rows } = await fastify.pg.query(
      `SELECT t.id, t.name, t.role, t.tenant_id, tn.name AS tenant_name
       FROM api_tokens t JOIN tenants tn ON tn.id = t.tenant_id
       WHERE t.token_hash = $1 AND (t.expires_at IS NULL OR t.expires_at > now())`,
      [hash]);
    const token = rows[0];
    if (!token) return null;
    // Best-effort usage stamp, throttled by only writing when stale >60s.
    fastify.pg.query(
      `UPDATE api_tokens SET last_used_at = now()
       WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`,
      [token.id]).catch(() => {});
    return {
      sub: token.id,
      username: `token:${token.name}`,
      role: token.role,
      tenantId: token.tenant_id,
      tenant: token.tenant_name,
      isToken: true,
    };
  }

  async function resolveIdentity(request) {
    try {
      await request.jwtVerify();
      return true;
    } catch {
      const tokenUser = await apiTokenUser(request);
      if (tokenUser) { request.user = tokenUser; return true; }
      return false;
    }
  }

  fastify.decorate('authenticate', async function authenticate(request, reply) {
    if (!(await resolveIdentity(request))) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  /**
   * Redis fixed-window rate limiter keyed by the authenticated principal
   * (user or API token id). Attach AFTER a requireRole guard so request.user
   * exists. A runaway integration gets clean 429s with Retry-After instead
   * of flooding the alert/metric tables.
   *
   *   preHandler: [fastify.requireRole('operator'), fastify.rateLimit('ingest', 120, 60)]
   */
  fastify.decorate('rateLimit', function rateLimit(bucket, max, windowS) {
    return async function rateGuard(request, reply) {
      const who = request.user?.sub ?? request.ip;
      const win = Math.floor(Date.now() / (windowS * 1000));
      const key = `watcher:rl:${bucket}:${who}:${win}`;
      try {
        const n = await fastify.redis.incr(key);
        if (n === 1) await fastify.redis.expire(key, windowS + 1);
        reply.header('X-RateLimit-Limit', max);
        reply.header('X-RateLimit-Remaining', Math.max(0, max - n));
        if (n > max) {
          const retryS = windowS - Math.floor((Date.now() / 1000) % windowS);
          return reply.code(429).header('Retry-After', retryS)
            .send({ error: `rate limit exceeded: ${max} requests per ${windowS}s for ${bucket}` });
        }
      } catch {
        // Redis briefly away — fail open; monitoring must not be the outage.
      }
    };
  });

  fastify.decorate('requireRole', function requireRole(minRole) {
    const need = ROLE_WEIGHT[minRole] ?? Infinity;
    return async function roleGuard(request, reply) {
      if (!(await resolveIdentity(request))) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const have = ROLE_WEIGHT[request.user?.role] ?? 0;
      if (have < need) {
        return reply.code(403).send({ error: 'forbidden', required: minRole });
      }
    };
  });
}, { name: 'watcher-auth', dependencies: ['watcher-db', 'watcher-redis'] });
