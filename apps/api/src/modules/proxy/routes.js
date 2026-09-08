/**
 * Remote site proxies — the control plane.
 *
 * Administration (admin role, session or token):
 *   GET    /api/proxy            the fleet, with health
 *   POST   /api/proxy            register a proxy; returns a one-time enrolment secret
 *   POST   /api/proxy/:id/reissue  a fresh enrolment secret (lost, or rotating)
 *   PATCH  /api/proxy/:id        rename, re-site, enable/disable, staleness deadline
 *   DELETE /api/proxy/:id        remove; its devices fall back to the central poller
 *
 * The proxy itself (its own credential, never a user session):
 *   POST /api/proxy/enrol        redeem the one-time secret for a durable one
 *   GET  /api/proxy/assignments  the devices this proxy is responsible for
 *   POST /api/proxy/report       deliver a batch of observations
 *   POST /api/proxy/heartbeat    "still here", with queue depth and version
 *
 * The proxy routes authenticate on `X-Proxy-Token` and resolve to exactly one
 * proxy row. A proxy is not a user and deliberately does not travel through
 * requireRole: a leaked proxy credential must not be usable to read alerts,
 * change configuration, or act on another site.
 */
import crypto from 'node:crypto';
import { REDIS_KEYS, proxyHealth, isStale } from '@watcher/shared';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
/** 32 bytes of CSPRNG, url-safe. Guessing is not a threat model we invite. */
const secret = (prefix) => `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;

/** Enrolment secrets are short-lived: a stale one is an unnecessary risk. */
const ENROL_TTL_MINUTES = 60;

export default async function proxyRoutes(fastify) {
  /**
   * Resolve X-Proxy-Token into the proxy it belongs to. Returns null rather
   * than throwing so each route can answer 401 in its own shape.
   */
  async function authenticateProxy(request) {
    const token = request.headers['x-proxy-token'];
    if (!token || typeof token !== 'string') return null;
    const { rows } = await fastify.pg.query(
      `SELECT * FROM proxies WHERE token_hash = $1 AND status = 'active'`,
      [sha256(token)]);
    return rows[0] ?? null;
  }

  /** Guard for the proxy-facing routes. */
  async function requireProxy(request, reply) {
    const proxy = await authenticateProxy(request);
    if (!proxy) {
      return reply.code(401).send({ error: 'a valid X-Proxy-Token is required' });
    }
    request.proxy = proxy;
    return undefined;
  }

  /* ── administration ───────────────────────────────────────────────── */

  fastify.get('/', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    const { rows } = await fastify.pg.query(
      `SELECT p.id, p.name, p.site, p.description, p.status, p.last_seen_at,
              p.agent_version, p.stale_after_seconds, p.queue_depth,
              p.enrolled_at, p.created_at,
              (p.enrol_hash IS NOT NULL AND p.enrol_expires > now()) AS enrolment_pending,
              count(d.id)::int AS devices
         FROM proxies p LEFT JOIN devices d ON d.proxy_id = p.id
        WHERE p.tenant_id = $1
        GROUP BY p.id
        ORDER BY p.site, p.name`,
      [request.user.tenantId]);

    const now = Date.now();
    return {
      proxies: rows.map((p) => ({
        ...p,
        health: proxyHealth({
          status: p.status, lastSeenAt: p.last_seen_at,
          staleAfterSeconds: p.stale_after_seconds, queueDepth: p.queue_depth,
        }, now),
      })),
    };
  });

  fastify.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          site: { type: 'string', maxLength: 100 },
          description: { type: 'string', maxLength: 500 },
          staleAfterSeconds: { type: 'integer', minimum: 60, maximum: 86_400 },
        },
        additionalProperties: false,
      },
    },
    preHandler: fastify.requireRole('admin'),
  }, async (request, reply) => {
    const b = request.body;
    const enrolSecret = secret('wpe');
    try {
      const { rows } = await fastify.pg.query(
        `INSERT INTO proxies
           (tenant_id, name, site, description, stale_after_seconds,
            enrol_hash, enrol_expires, created_by)
         VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' minutes')::interval, $8)
         RETURNING id, name, site, status`,
        [request.user.tenantId, b.name, b.site ?? '', b.description ?? '',
          b.staleAfterSeconds ?? 300, sha256(enrolSecret), ENROL_TTL_MINUTES,
          request.user.sub ?? null]);
      // Shown once. There is no route that can return it again — a reissue
      // mints a new one, which is what makes the original single-use.
      return reply.code(201).send({
        proxy: rows[0],
        enrolmentSecret: enrolSecret,
        expiresInMinutes: ENROL_TTL_MINUTES,
        note: 'Shown once. Set WATCHER_PROXY_ENROL on the remote poller before it expires.',
      });
    } catch (err) {
      if (err.code === '23505') {
        return reply.code(409).send({ error: 'a proxy with that name already exists' });
      }
      throw err;
    }
  });

  fastify.post('/:id/reissue', {
    preHandler: fastify.requireRole('admin'),
  }, async (request, reply) => {
    const enrolSecret = secret('wpe');
    // Reissuing also revokes the durable credential: the point of asking is
    // that the proxy is being rebuilt or its credential is suspect, and
    // leaving the old one live would defeat the exercise.
    const { rows } = await fastify.pg.query(
      `UPDATE proxies
          SET enrol_hash = $3, enrol_expires = now() + ($4 || ' minutes')::interval,
              token_hash = NULL, status = 'pending'
        WHERE id = $1 AND tenant_id = $2
        RETURNING id, name`,
      [request.params.id, request.user.tenantId, sha256(enrolSecret), ENROL_TTL_MINUTES]);
    if (!rows[0]) return reply.code(404).send({ error: 'no such proxy' });
    return {
      proxy: rows[0], enrolmentSecret: enrolSecret, expiresInMinutes: ENROL_TTL_MINUTES,
      note: 'The previous proxy credential has been revoked.',
    };
  });

  fastify.patch('/:id', {
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          site: { type: 'string', maxLength: 100 },
          description: { type: 'string', maxLength: 500 },
          status: { type: 'string', enum: ['active', 'disabled'] },
          staleAfterSeconds: { type: 'integer', minimum: 60, maximum: 86_400 },
        },
        additionalProperties: false,
      },
    },
    preHandler: fastify.requireRole('admin'),
  }, async (request, reply) => {
    const columns = { name: 'name', site: 'site', description: 'description',
      status: 'status', staleAfterSeconds: 'stale_after_seconds' };
    const sets = [];
    const params = [request.params.id, request.user.tenantId];
    for (const [key, column] of Object.entries(columns)) {
      if (request.body?.[key] === undefined) continue;
      params.push(request.body[key]);
      sets.push(`${column} = $${params.length}${column === 'status' ? '::proxy_status' : ''}`);
    }
    if (!sets.length) return reply.code(400).send({ error: 'nothing to update' });
    const { rows } = await fastify.pg.query(
      `UPDATE proxies SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      params);
    if (!rows[0]) return reply.code(404).send({ error: 'no such proxy' });
    return { proxy: rows[0] };
  });

  fastify.delete('/:id', {
    preHandler: fastify.requireRole('admin'),
  }, async (request, reply) => {
    // devices.proxy_id is ON DELETE SET NULL, so the site's devices return
    // to the central poller rather than silently stopping being monitored.
    const { rowCount } = await fastify.pg.query(
      `DELETE FROM proxies WHERE id = $1 AND tenant_id = $2`,
      [request.params.id, request.user.tenantId]);
    if (!rowCount) return reply.code(404).send({ error: 'no such proxy' });
    return reply.code(204).send();
  });

  /* ── the proxy's own routes ───────────────────────────────────────── */

  /**
   * Redeem a one-time enrolment secret for a durable credential.
   *
   * The UPDATE is the whole security property: it matches on the enrolment
   * hash AND clears it in the same statement, so two proxies racing the same
   * secret produce exactly one winner — the second finds no row. A
   * check-then-write here would let a replayed secret mint a second
   * credential for the same site.
   */
  fastify.post('/enrol', {
    schema: {
      body: {
        type: 'object',
        required: ['secret'],
        properties: {
          secret: { type: 'string', minLength: 8, maxLength: 200 },
          agentVersion: { type: 'string', maxLength: 50 },
        },
        additionalProperties: false,
      },
    },
    config: { rateLimit: false },
  }, async (request, reply) => {
    const proxyToken = secret('wpt');
    const { rows } = await fastify.pg.query(
      `UPDATE proxies
          SET token_hash = $2, status = 'active', enrolled_at = now(),
              enrolled_from = $3, enrol_hash = NULL, enrol_expires = NULL,
              agent_version = $4, last_seen_at = now()
        WHERE enrol_hash = $1 AND enrol_expires > now()
        RETURNING id, name, site, stale_after_seconds`,
      [sha256(request.body.secret), sha256(proxyToken), request.ip,
        request.body.agentVersion ?? '']);

    if (!rows[0]) {
      // One message for "wrong", "expired" and "already used". Which of the
      // three it was is exactly what an attacker would like to know.
      return reply.code(401).send({ error: 'enrolment secret is not valid' });
    }
    fastify.log.info({ proxy: rows[0].name, from: request.ip }, 'proxy enrolled');
    return reply.code(201).send({
      proxy: rows[0],
      proxyToken,
      note: 'Store this as WATCHER_PROXY_TOKEN. It is not recoverable.',
    });
  });

  /** The devices this proxy is responsible for. */
  fastify.get('/assignments', { preHandler: requireProxy }, async (request) => {
    // The credential is named, never sent. A proxy holds its own secrets
    // locally, so no device password ever leaves the centre and a captured
    // proxy credential yields no way into the site's equipment. It is also
    // why a site will host one at all.
    const { rows } = await fastify.pg.query(
      `SELECT d.id, d.name, host(d.address) AS address, d.kind, d.tags,
              pa.protocol, pa.interval_s, pa.config, c.name AS credential_ref
         FROM devices d
         JOIN poll_assignments pa ON pa.device_id = d.id AND pa.enabled
         LEFT JOIN credentials c ON c.id = pa.credential_id
        WHERE d.proxy_id = $1 AND d.tenant_id = $2 AND d.monitored
        ORDER BY d.name, pa.protocol`,
      [request.proxy.id, request.proxy.tenant_id]);

    await fastify.pg.query(
      `UPDATE proxies SET last_seen_at = now() WHERE id = $1`, [request.proxy.id]);

    return {
      proxy: { id: request.proxy.id, name: request.proxy.name },
      // The proxy re-reads on this cadence; changing it centrally is how a
      // whole fleet's polling is retuned without touching a remote host.
      refreshSeconds: 300,
      devices: rows,
    };
  });

  /**
   * Deliver a batch of observations.
   *
   * Metrics land in the metric store; state changes go onto the same
   * `watcher:events:state` channel the Nagios streamer writes, so a remote
   * site's alerts go through correlation, on-call and runbooks exactly like
   * a local one. There is one alert model in this product.
   */
  fastify.post('/report', {
    schema: {
      body: {
        type: 'object',
        properties: {
          metrics: {
            type: 'array', maxItems: 5000,
            items: {
              type: 'object',
              required: ['deviceId', 'metric', 'value'],
              properties: {
                deviceId: { type: 'string', maxLength: 64 },
                metric: { type: 'string', maxLength: 100 },
                instance: { type: 'string', maxLength: 200 },
                value: { type: 'number' },
                at: { type: 'string' },
              },
            },
          },
          states: {
            type: 'array', maxItems: 2000,
            items: {
              type: 'object',
              required: ['deviceId', 'state'],
              properties: {
                deviceId: { type: 'string', maxLength: 64 },
                check: { type: 'string', maxLength: 200 },
                state: { type: 'integer', minimum: 0, maximum: 3 },
                output: { type: 'string', maxLength: 1024 },
                at: { type: 'string' },
              },
            },
          },
          queueDepth: { type: 'integer', minimum: 0 },
          agentVersion: { type: 'string', maxLength: 50 },
        },
        additionalProperties: false,
      },
    },
    preHandler: requireProxy,
  }, async (request) => {
    const proxy = request.proxy;
    const metrics = request.body?.metrics ?? [];
    const states = request.body?.states ?? [];

    // A proxy may only report on devices assigned to it. Without this a
    // leaked credential from the least important site can inject state for
    // any device in the estate — including resolving alerts on the most
    // important one.
    // Addressed by id, so a device rename mid-flight does not discard a
    // buffered batch; the name is resolved here for the state bus.
    const { rows: owned } = await fastify.pg.query(
      `SELECT id, name FROM devices WHERE proxy_id = $1 AND tenant_id = $2`,
      [proxy.id, proxy.tenant_id]);
    const nameOf = new Map(owned.map((d) => [d.id, d.name]));

    let acceptedMetrics = 0;
    let rejected = 0;

    if (metrics.length) {
      const params = [];
      const tuples = [];
      for (const m of metrics) {
        if (!nameOf.has(m.deviceId)) { rejected++; continue; }
        const o = params.length;
        params.push(m.at ? new Date(m.at) : new Date(), m.deviceId, m.metric,
          m.instance ?? '', m.value);
        tuples.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5})`);
      }
      if (tuples.length) {
        await fastify.tsdb.query(
          `INSERT INTO metrics (time, device_id, metric, instance, value)
           VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`, params);
        acceptedMetrics = tuples.length;
      }
    }

    let acceptedStates = 0;
    for (const s of states) {
      const deviceName = nameOf.get(s.deviceId);
      if (!deviceName) { rejected++; continue; }
      await fastify.redis.publish(REDIS_KEYS.eventsState, JSON.stringify({
        host: deviceName,
        service: s.check ?? '',
        kind: s.check ? 'service' : 'host',
        state: s.state,
        hard: true,
        output: s.output ?? '',
        tenantId: proxy.tenant_id,
        prevState: null,
        ts: s.at ? new Date(s.at).getTime() : Date.now(),
        origin: 'proxy',
        originProxy: proxy.name,
      })).catch(() => {});
      acceptedStates++;
    }

    await fastify.pg.query(
      `UPDATE proxies SET last_seen_at = now(), queue_depth = $2,
              agent_version = coalesce(nullif($3, ''), agent_version)
        WHERE id = $1`,
      [proxy.id, request.body?.queueDepth ?? 0, request.body?.agentVersion ?? '']);

    if (rejected) {
      fastify.log.warn({ proxy: proxy.name, rejected },
        'proxy reported on devices it does not own');
    }
    // The proxy commits its buffer on this answer, so it must be honest
    // about what was actually taken.
    return { acceptedMetrics, acceptedStates, rejected };
  });

  fastify.post('/heartbeat', {
    schema: {
      body: {
        type: 'object',
        properties: {
          queueDepth: { type: 'integer', minimum: 0 },
          agentVersion: { type: 'string', maxLength: 50 },
        },
        additionalProperties: false,
      },
    },
    preHandler: requireProxy,
  }, async (request) => {
    await fastify.pg.query(
      `UPDATE proxies SET last_seen_at = now(), queue_depth = $2,
              agent_version = coalesce(nullif($3, ''), agent_version)
        WHERE id = $1`,
      [request.proxy.id, request.body?.queueDepth ?? 0, request.body?.agentVersion ?? '']);
    return { ok: true, staleAfterSeconds: request.proxy.stale_after_seconds };
  });
}

/**
 * The silence watchdog.
 *
 * When a proxy stops reporting, its whole site stops being checked — and the
 * console shows no alerts for that site, because nothing is checking it. The
 * site looks *healthy*. This is the failure mode that makes a distributed
 * monitoring system worse than none at all, because it is trusted.
 *
 * So proxy silence is itself a critical alert, raised against the proxy's own
 * name so it lands in the same console, the same on-call rotation and the
 * same escalation as everything else. Exported and started by the app.
 */
export class ProxyWatchdog {
  constructor({ pg, redis, log, intervalMs = 60_000 }) {
    this.pg = pg;
    this.redis = redis;
    this.log = log;
    this.intervalMs = intervalMs;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(
      () => this.sweep().catch((err) => this.log.error({ err }, 'proxy watchdog failed')),
      this.intervalMs);
    this.timer.unref();
    this.log.info('proxy silence watchdog started');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(now = Date.now()) {
    const { rows } = await this.pg.query(
      `SELECT id, tenant_id, name, site, status, last_seen_at, stale_after_seconds,
              (SELECT count(*) FROM devices d WHERE d.proxy_id = p.id)::int AS devices
         FROM proxies p WHERE status = 'active'`);

    let raised = 0;
    for (const p of rows) {
      const stale = isStale({
        status: p.status, lastSeenAt: p.last_seen_at, staleAfterSeconds: p.stale_after_seconds,
      }, now);
      const silentFor = p.last_seen_at
        ? Math.round((now - new Date(p.last_seen_at).getTime()) / 1000) : null;

      await this.redis.publish(REDIS_KEYS.eventsState, JSON.stringify({
        host: p.name,
        service: 'proxy reachability',
        kind: 'service',
        // 2 = CRITICAL, 0 = OK. A recovered proxy resolves its own alert
        // through the same path, so nothing has to remember it was raised.
        state: stale ? 2 : 0,
        hard: true,
        output: stale
          ? `Proxy "${p.name}"${p.site ? ` at ${p.site}` : ''} has been silent for ${silentFor}s `
            + `(deadline ${p.stale_after_seconds}s). ${p.devices} device(s) are NOT being monitored.`
          : `Proxy "${p.name}" is reporting.`,
        tenantId: p.tenant_id,
        prevState: null,
        ts: now,
        origin: 'proxy-watchdog',
      })).catch(() => {});
      if (stale) raised++;
    }
    if (raised) this.log.warn({ silent: raised }, 'proxies are silent — sites unmonitored');
    return raised;
  }
}
