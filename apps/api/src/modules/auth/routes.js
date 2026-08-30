/** Login + session info + user management (admin) + SSO (OIDC/LDAP). */
import crypto from 'node:crypto';
import { REDIS_KEYS } from '@watcher/shared';
import { hashPassword, verifyPassword } from './password.js';
import { OidcClient } from './sso.js';
import { LdapAuth } from './ldap.js';

/** Sentinel hash for IdP-owned accounts — never matches any password. */
const SSO_SENTINEL = 'sso$external-identity';

// A real scrypt hash of a random string, used to spend the same CPU verifying a
// login for a non-existent user as for a real one — closes the timing oracle
// that would otherwise let an attacker enumerate usernames.
const DUMMY_HASH =
  'scrypt$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000';

const MAX_ATTEMPTS = 10;
const LOCKOUT_WINDOW_S = 300;

export default async function authRoutes(fastify, opts) {
  const ssoCfg = opts.sso ?? { oidc: {}, ldap: {} };
  const oidc = new OidcClient(ssoCfg.oidc ?? {});
  const ldap = new LdapAuth(ssoCfg.ldap ?? {});
  const publicBaseUrl = (opts.publicBaseUrl ?? '').replace(/\/$/, '');

  /** JIT-provision (or refresh) a user coming from an IdP/directory. */
  async function upsertSsoUser(identity, source, tenantName = 'default') {
    const { rows: trows } = await fastify.pg.query(
      'SELECT id, name FROM tenants WHERE name = $1', [tenantName]);
    if (!trows[0]) throw new Error(`tenant "${tenantName}" not found`);
    const { rows } = await fastify.pg.query(
      `INSERT INTO users (tenant_id, username, display_name, email, role, password_hash, auth_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, username) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             email = COALESCE(EXCLUDED.email, users.email),
             role = EXCLUDED.role,           -- IdP groups are authoritative
             auth_source = EXCLUDED.auth_source
       RETURNING id, username, display_name, role, disabled`,
      [trows[0].id, identity.username, identity.displayName, identity.email,
       identity.role, SSO_SENTINEL, source]);
    const user = rows[0];
    if (user.disabled) return null; // locally disabled beats IdP say-so
    return { ...user, tenant_id: trows[0].id, tenant_name: trows[0].name };
  }

  function issueSession(user) {
    return fastify.jwt.sign({
      sub: user.id,
      username: user.username,
      role: user.role,
      tenantId: user.tenant_id,
      tenant: user.tenant_name,
    });
  }

  /** What the login page needs to render its buttons — public by design. */
  fastify.get('/sso/config', async () => ({
    oidc: oidc.enabled ? { label: ssoCfg.oidc.label ?? 'Single sign-on' } : null,
    ldap: ldap.enabled,
  }));

  /** Step 1: hand the browser to the IdP with an anti-CSRF state. */
  fastify.get('/sso/login', async (request, reply) => {
    if (!oidc.enabled) return reply.code(404).send({ error: 'SSO not configured' });
    const state = oidc.newState();
    await fastify.redis.set(`watcher:sso:state:${state}`, '1', 'EX', 600);
    const redirectUri = `${publicBaseUrl}/api/auth/sso/callback`;
    return reply.redirect(await oidc.authUrl(state, redirectUri));
  });

  /** Step 2: IdP returns; exchange the code, mint a Watcher session. */
  fastify.get('/sso/callback', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          code: { type: 'string' }, state: { type: 'string' },
          error: { type: 'string' }, error_description: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const fail = (msg) => reply.redirect(`/login.html#sso_error=${encodeURIComponent(msg)}`);
    if (!oidc.enabled) return reply.code(404).send({ error: 'SSO not configured' });
    const { code, state, error, error_description: desc } = request.query;
    if (error) return fail(desc || error);
    if (!code || !state) return fail('missing code or state');
    const known = await fastify.redis.getdel(`watcher:sso:state:${state}`);
    if (!known) return fail('login expired — try again');

    try {
      const redirectUri = `${publicBaseUrl}/api/auth/sso/callback`;
      const claims = await oidc.exchange(code, redirectUri);
      const identity = oidc.identityFor(claims);
      if (!identity) return fail('your account has no access here — ask an admin to map your group');
      const user = await upsertSsoUser(identity, 'oidc');
      if (!user) return fail('account disabled');
      const token = issueSession(user);
      // Fragment (never query) so the token stays out of server logs.
      return reply.redirect(`/login.html#sso_token=${encodeURIComponent(token)}`);
    } catch (err) {
      request.log.error({ err }, 'OIDC callback failed');
      return fail('sign-in failed — check with your administrator');
    }
  });

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
              u.password_change_required, u.auth_source,
              t.id AS tenant_id, t.name AS tenant_name
       FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.username = $1 AND t.name = $2`,
      [username, tenant],
    );
    let user = rows[0];
    // Always run a verify (real or dummy) so response time doesn't reveal
    // whether the username exists.
    const valid = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    let ok = Boolean(user) && !user.disabled && valid;

    // Directory fallback: only when no LOCAL account claims this username —
    // a local password account can never be shadowed by the directory.
    if (!ok && ldap.enabled && (!user || user.auth_source === 'ldap')) {
      try {
        const identity = await ldap.authenticate(username, password);
        if (identity) {
          const provisioned = await upsertSsoUser(identity, 'ldap', tenant);
          if (provisioned) {
            user = { ...provisioned, password_change_required: false };
            ok = true;
          }
        }
      } catch (err) {
        request.log.error({ err }, 'LDAP authentication errored (directory unreachable?)');
      }
    }

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

  // ── Scoped API tokens (automation: CI, scripts, integrations) ─────────────
  fastify.get('/tokens', { preHandler: fastify.requireRole('admin') }, async (request) => {
    const { rows } = await fastify.pg.query(
      `SELECT t.id, t.name, t.role, t.created_at, t.last_used_at, t.expires_at,
              u.username AS created_by_name
       FROM api_tokens t LEFT JOIN users u ON u.id = t.created_by
       WHERE t.tenant_id = $1 ORDER BY t.created_at DESC`,
      [request.user.tenantId]);
    return { tokens: rows };
  });

  fastify.post('/tokens', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          role: { type: 'string', enum: ['admin', 'operator', 'viewer'], default: 'viewer' },
          expiresInDays: { type: 'integer', minimum: 1, maximum: 3650 },
        },
      },
    },
    preHandler: fastify.requireRole('admin'),
  }, async (request, reply) => {
    // Tokens are minted by humans only — a token must never mint more tokens.
    if (request.user.isToken) {
      return reply.code(403).send({ error: 'API tokens cannot create tokens' });
    }
    const { name, role = 'viewer', expiresInDays } = request.body;
    const secret = `wtk_${crypto.randomBytes(24).toString('base64url')}`;
    const hash = crypto.createHash('sha256').update(secret).digest('hex');
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 86400e3).toISOString() : null;
    const { rows } = await fastify.pg.query(
      `INSERT INTO api_tokens (tenant_id, name, token_hash, role, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, role, created_at, expires_at`,
      [request.user.tenantId, name, hash, role, request.user.sub, expiresAt]);
    // The plaintext is returned exactly once; only the hash is stored.
    return reply.code(201).send({ token: rows[0], secret });
  });

  fastify.delete('/tokens/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
    preHandler: fastify.requireRole('admin'),
  }, async (request, reply) => {
    const { rowCount } = await fastify.pg.query(
      'DELETE FROM api_tokens WHERE id = $1 AND tenant_id = $2',
      [request.params.id, request.user.tenantId]);
    if (rowCount === 0) return reply.code(404).send({ error: 'not found' });
    return reply.code(204).send();
  });
}
