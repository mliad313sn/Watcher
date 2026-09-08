/**
 * The event plane's read and administration surface.
 *
 *   GET    /api/events            search received traps and syslog
 *   GET    /api/events/summary    volume by source and device, for the console
 *   GET    /api/events/rules      the decision list
 *   POST   /api/events/rules      add a rule            (operator)
 *   PATCH  /api/events/rules/:id  edit one              (operator)
 *   DELETE /api/events/rules/:id  remove one            (operator)
 *   GET    /api/events/sources    the sender allow-list
 *   POST   /api/events/sources    add a sender          (operator)
 *   DELETE /api/events/sources/:id                      (operator)
 *   POST   /api/events/test       evaluate a rule set against a sample event
 *
 * Every write publishes `watcher:events:rules-changed` so the receivers pick
 * the change up on the next event rather than after their cache expires. A
 * rule you edited that does not take effect for thirty seconds is a rule you
 * will edit twice.
 */
import { evaluateEvent, compilePattern, MAX_PATTERN_LENGTH } from '@watcher/shared';

const RULES_CHANGED = 'watcher:events:rules-changed';

const RULE_PROPERTIES = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  source: { type: 'string', enum: ['trap', 'syslog'], nullable: true },
  enabled: { type: 'boolean' },
  priority: { type: 'integer', minimum: 0, maximum: 10_000 },
  matchOid: { type: 'string', maxLength: 200 },
  matchPattern: { type: 'string', maxLength: MAX_PATTERN_LENGTH },
  matchApp: { type: 'string', maxLength: 100 },
  matchFacility: { type: 'integer', minimum: 0, maximum: 23, nullable: true },
  maxSeverity: { type: 'integer', minimum: 0, maximum: 7, nullable: true },
  action: { type: 'string', enum: ['alert', 'clear', 'drop', 'log'] },
  severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
  checkName: { type: 'string', maxLength: 200 },
  autoClearSeconds: { type: 'integer', minimum: 30, maximum: 604_800, nullable: true },
};

/** Database row → the shape @watcher/shared's rule engine reads. */
export function rowToRule(r) {
  return {
    id: r.id, name: r.name, source: r.source ?? 'any', enabled: r.enabled,
    priority: r.priority, matchOid: r.match_oid, matchPattern: r.match_pattern,
    matchApp: r.match_app, matchFacility: r.match_facility,
    maxSeverity: r.max_severity, action: r.action, severity: r.severity,
    checkName: r.check_name, autoClearSeconds: r.auto_clear_seconds,
  };
}

export default async function eventRoutes(fastify) {
  const announce = () => fastify.redis.publish(RULES_CHANGED, '1').catch(() => {});

  /* ── search ──────────────────────────────────────────────────────── */

  fastify.get('/', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    const q = request.query ?? {};
    const params = [request.user.tenantId];
    const where = ['tenant_id = $1'];

    if (q.source) { params.push(q.source); where.push(`source = $${params.length}`); }
    if (q.device) { params.push(q.device); where.push(`device_name = $${params.length}`); }
    if (q.action) { params.push(q.action); where.push(`action = $${params.length}`); }
    if (q.oid) { params.push(String(q.oid) + '%'); where.push(`oid LIKE $${params.length}`); }
    if (q.maxSeverity !== undefined && q.maxSeverity !== '') {
      params.push(Number(q.maxSeverity));
      where.push(`severity <= $${params.length}`);
    }
    if (q.since) { params.push(q.since); where.push(`time >= $${params.length}`); }
    if (q.q) {
      // Substring, not full text: an operator searching events is looking
      // for an interface name or an IP, and a stemmer would lose both.
      params.push('%' + String(q.q).slice(0, 200) + '%');
      where.push(`message ILIKE $${params.length}`);
    }

    const limit = Math.min(Math.max(Number(q.limit ?? 200), 1), 1000);
    params.push(limit);

    const { rows } = await fastify.tsdb.query(
      `SELECT time, source, device_id, device_name, host(source_ip) AS source_ip, oid,
              facility, severity, app_name, message, detail, rule_name, action, check_name
         FROM events
        WHERE ${where.join(' AND ')}
        ORDER BY time DESC
        LIMIT $${params.length}`,
      params);
    return { events: rows, limit };
  });

  /** Volume by sender — the "who is shouting" view, served from the rollup. */
  fastify.get('/summary', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    const hours = Math.min(Math.max(Number(request.query?.hours ?? 24), 1), 24 * 30);
    const { rows } = await fastify.tsdb.query(
      `SELECT source, device_name,
              sum(events)::bigint   AS events,
              sum(alerting)::bigint AS alerting,
              sum(errors)::bigint   AS errors
         FROM events_rate_1h
        WHERE tenant_id = $1 AND bucket >= now() - ($2 || ' hours')::interval
        GROUP BY source, device_name
        ORDER BY events DESC
        LIMIT 100`,
      [request.user.tenantId, hours]);
    return { hours, senders: rows };
  });

  /* ── rules ───────────────────────────────────────────────────────── */

  fastify.get('/rules', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    const { rows } = await fastify.pg.query(
      `SELECT * FROM event_rules WHERE tenant_id = $1 ORDER BY priority, name`,
      [request.user.tenantId]);
    return { rules: rows.map(rowToRule) };
  });

  fastify.post('/rules', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: RULE_PROPERTIES,
        additionalProperties: false,
      },
    },
    preHandler: fastify.requireRole('operator'),
  }, async (request, reply) => {
    const b = request.body;
    const refusal = validateRule(b);
    if (refusal) return reply.code(400).send({ error: refusal });

    const { rows } = await fastify.pg.query(
      `INSERT INTO event_rules
         (tenant_id, name, source, enabled, priority, match_oid, match_pattern, match_app,
          match_facility, max_severity, action, severity, check_name, auto_clear_seconds)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [request.user.tenantId, b.name, b.source ?? null, b.enabled ?? true, b.priority ?? 100,
        b.matchOid ?? '', b.matchPattern ?? '', b.matchApp ?? '',
        b.matchFacility ?? null, b.maxSeverity ?? null,
        b.action ?? 'alert', b.severity ?? 'warning', b.checkName ?? '',
        b.autoClearSeconds ?? null]);
    await announce();
    return reply.code(201).send({ rule: rowToRule(rows[0]) });
  });

  fastify.patch('/rules/:id', {
    schema: { body: { type: 'object', properties: RULE_PROPERTIES, additionalProperties: false } },
    preHandler: fastify.requireRole('operator'),
  }, async (request, reply) => {
    const b = request.body ?? {};
    const refusal = validateRule(b);
    if (refusal) return reply.code(400).send({ error: refusal });

    const columns = {
      name: 'name', source: 'source', enabled: 'enabled', priority: 'priority',
      matchOid: 'match_oid', matchPattern: 'match_pattern', matchApp: 'match_app',
      matchFacility: 'match_facility', maxSeverity: 'max_severity',
      action: 'action', severity: 'severity', checkName: 'check_name',
      autoClearSeconds: 'auto_clear_seconds',
    };
    const sets = [];
    const params = [request.params.id, request.user.tenantId];
    for (const [key, column] of Object.entries(columns)) {
      if (b[key] === undefined) continue;
      params.push(b[key]);
      sets.push(`${column} = $${params.length}`);
    }
    if (!sets.length) return reply.code(400).send({ error: 'nothing to update' });

    const { rows } = await fastify.pg.query(
      `UPDATE event_rules SET ${sets.join(', ')}
        WHERE id = $1 AND tenant_id = $2 RETURNING *`, params);
    if (!rows[0]) return reply.code(404).send({ error: 'no such rule' });
    await announce();
    return { rule: rowToRule(rows[0]) };
  });

  fastify.delete('/rules/:id', {
    preHandler: fastify.requireRole('operator'),
  }, async (request, reply) => {
    const { rowCount } = await fastify.pg.query(
      `DELETE FROM event_rules WHERE id = $1 AND tenant_id = $2`,
      [request.params.id, request.user.tenantId]);
    if (!rowCount) return reply.code(404).send({ error: 'no such rule' });
    await announce();
    return reply.code(204).send();
  });

  /* ── senders ─────────────────────────────────────────────────────── */

  fastify.get('/sources', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    const { rows } = await fastify.pg.query(
      `SELECT s.id, host(s.address) AS address, s.device_id, s.label, s.enabled,
              s.created_at, d.name AS device_name
         FROM event_sources s LEFT JOIN devices d ON d.id = s.device_id
        WHERE s.tenant_id = $1 ORDER BY s.address`,
      [request.user.tenantId]);
    return { sources: rows };
  });

  fastify.post('/sources', {
    schema: {
      body: {
        type: 'object',
        required: ['address'],
        properties: {
          address: { type: 'string', minLength: 3, maxLength: 45 },
          deviceId: { type: 'string', format: 'uuid', nullable: true },
          label: { type: 'string', maxLength: 200 },
          enabled: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    preHandler: fastify.requireRole('operator'),
  }, async (request, reply) => {
    const b = request.body;
    if (!b.deviceId && !b.label) {
      return reply.code(400).send({
        error: 'a source needs either a device to attribute its events to, or a label',
      });
    }
    try {
      const { rows } = await fastify.pg.query(
        `INSERT INTO event_sources (tenant_id, address, device_id, label, enabled)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, address) DO UPDATE
           SET device_id = EXCLUDED.device_id, label = EXCLUDED.label,
               enabled = EXCLUDED.enabled
         RETURNING id, host(address) AS address, device_id, label, enabled`,
        [request.user.tenantId, b.address, b.deviceId ?? null, b.label ?? '', b.enabled ?? true]);
      await announce();
      return reply.code(201).send({ source: rows[0] });
    } catch (err) {
      if (err.code === '22P02') return reply.code(400).send({ error: 'address is not an IP address' });
      throw err;
    }
  });

  fastify.delete('/sources/:id', {
    preHandler: fastify.requireRole('operator'),
  }, async (request, reply) => {
    const { rowCount } = await fastify.pg.query(
      `DELETE FROM event_sources WHERE id = $1 AND tenant_id = $2`,
      [request.params.id, request.user.tenantId]);
    if (!rowCount) return reply.code(404).send({ error: 'no such source' });
    await announce();
    return reply.code(204).send();
  });

  /* ── dry run ─────────────────────────────────────────────────────── */

  /**
   * Answer "what would this event do?" without waiting for the device to
   * send another one. The single most useful thing you can give someone
   * writing rules, and the reason the engine is a pure function in
   * @watcher/shared rather than logic buried in the receiver.
   */
  fastify.post('/test', {
    schema: {
      body: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['trap', 'syslog'] },
          oid: { type: 'string', maxLength: 200 },
          message: { type: 'string', maxLength: 4096 },
          appName: { type: 'string', maxLength: 100 },
          facility: { type: 'integer', minimum: 0, maximum: 23, nullable: true },
          severity: { type: 'integer', minimum: 0, maximum: 7, nullable: true },
          deviceName: { type: 'string', maxLength: 200 },
        },
        additionalProperties: false,
      },
    },
    preHandler: fastify.requireRole('viewer'),
  }, async (request) => {
    const { rows } = await fastify.pg.query(
      `SELECT * FROM event_rules WHERE tenant_id = $1 AND enabled ORDER BY priority, id`,
      [request.user.tenantId]);
    const b = request.body ?? {};
    const decision = evaluateEvent(rows.map(rowToRule), {
      source: b.source ?? 'syslog',
      oid: b.oid ?? '',
      message: b.message ?? '',
      appName: b.appName ?? '',
      facility: b.facility ?? null,
      severity: b.severity ?? null,
      deviceName: b.deviceName ?? 'example-device',
    });
    return { decision };
  });
}

/**
 * Refuse a rule that cannot do what its author means, at the moment they
 * write it. Each of these is a way to build a rule that looks correct in the
 * list and does nothing at 3am.
 */
export function validateRule(b) {
  if (b.matchPattern) {
    if (!compilePattern(b.matchPattern)) return 'matchPattern is not a usable regular expression';
  }
  if (b.matchOid && !/^\.?\d+(\.\d+)*\.?$/.test(b.matchOid)) {
    return 'matchOid must be a numeric OID such as 1.3.6.1.6.3.1.1.5.3';
  }
  // A clearing rule with no check name clears the default check name, which
  // is derived per event and will not equal the one a raise produced.
  if (b.action === 'clear' && b.checkName !== undefined && !b.checkName) {
    return 'a clear rule needs the same checkName as the rule whose alert it closes';
  }
  // Capture groups in a template that no pattern can fill render empty, and
  // silently fold every alert onto one row.
  if (b.checkName && /\{[1-9]\}/.test(b.checkName) && !b.matchPattern) {
    return 'checkName uses a capture group, so matchPattern must define one';
  }
  return null;
}
