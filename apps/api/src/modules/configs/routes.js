/**
 * Configuration backup — history, diffs, baselines and drift.
 *
 *   GET  /api/configs                fleet drift overview
 *   GET  /api/configs/:deviceId      version history for one device
 *   GET  /api/configs/version/:id    one version's content
 *   GET  /api/configs/:deviceId/diff?from=&to=   a unified diff
 *   POST /api/configs/:deviceId/approve          approve a version as baseline
 *   GET  /api/configs/targets        which devices are backed up
 *   POST /api/configs/targets        enable backup for a device      (admin)
 *   DELETE /api/configs/targets/:deviceId                            (admin)
 *
 * Reading a stored configuration is an operator-or-above act even though the
 * secrets are redacted: a config still describes ACLs, VPN endpoints, routing
 * and management addresses, which is a map of the network for anyone who
 * should not have one. A viewer sees drift status and history, not content.
 */
import { diffConfigs, driftStatus, VENDOR_PROFILES } from '@watcher/shared';

/* Path parameters are uuids in every one of these routes. Validated here so
   a malformed one answers 400 rather than reaching Postgres, becoming a
   22P02, and surfacing as a 500 for what is plainly a bad request. */
const DEVICE_PARAM = {
  params: { type: 'object', required: ['deviceId'],
    properties: { deviceId: { type: 'string', format: 'uuid' } } },
};
const ID_PARAM = {
  params: { type: 'object', required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } } },
};

export default async function configRoutes(fastify) {
  /** Fleet view: who is drifting, who has never been captured, who is failing. */
  fastify.get('/', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    const { rows } = await fastify.pg.query(
      `SELECT d.id AS device_id, d.name AS device_name, t.vendor, t.enabled,
              latest.content_hash AS current_hash, latest.captured_at,
              latest.lines_added, latest.lines_removed,
              b.content_hash AS baseline_hash, b.approved_at, u.username AS approved_by,
              fail.error AS last_error, fail.at AS last_error_at
         FROM config_targets t
         JOIN devices d ON d.id = t.device_id
         LEFT JOIN LATERAL (
           SELECT content_hash, captured_at, lines_added, lines_removed
             FROM device_configs c
            WHERE c.device_id = t.device_id
            ORDER BY captured_at DESC LIMIT 1
         ) latest ON true
         LEFT JOIN config_baselines b ON b.device_id = t.device_id
         LEFT JOIN users u ON u.id = b.approved_by
         LEFT JOIN LATERAL (
           SELECT error, at FROM config_captures c
            WHERE c.device_id = t.device_id AND c.status = 'failed'
            ORDER BY at DESC LIMIT 1
         ) fail ON true
        WHERE t.tenant_id = $1
        ORDER BY d.name`,
      [request.user.tenantId]);

    return {
      devices: rows.map((r) => ({
        ...r,
        drift: driftStatus({ currentHash: r.current_hash, baselineHash: r.baseline_hash }),
        // A capture that failed after the last success is the state that
        // matters: the history looks fine and is quietly going stale.
        stale: !!(r.last_error_at && r.captured_at && r.last_error_at > r.captured_at),
      })),
      vendors: Object.entries(VENDOR_PROFILES).map(([id, p]) => ({ id, label: p.label })),
    };
  });

  /** Version history for one device — metadata only, never content. */
  fastify.get('/:deviceId', { schema: DEVICE_PARAM, preHandler: fastify.requireRole('viewer') }, async (request) => {
    const { rows } = await fastify.pg.query(
      `SELECT c.id, c.content_hash, c.captured_at, c.vendor, c.raw_bytes,
              c.lines_added, c.lines_removed,
              length(c.content) AS normalised_bytes,
              (b.config_id = c.id) AS is_baseline
         FROM device_configs c
         LEFT JOIN config_baselines b ON b.device_id = c.device_id
        WHERE c.device_id = $1 AND c.tenant_id = $2
        ORDER BY c.captured_at DESC
        LIMIT 100`,
      [request.params.deviceId, request.user.tenantId]);

    const { rows: captures } = await fastify.pg.query(
      `SELECT status, error, duration_ms, at FROM config_captures
        WHERE device_id = $1 AND tenant_id = $2 ORDER BY at DESC LIMIT 20`,
      [request.params.deviceId, request.user.tenantId]);

    return { versions: rows, captures };
  });

  /** One version's content. Operator+, for the reason at the top of the file. */
  fastify.get('/version/:id', { schema: ID_PARAM, preHandler: fastify.requireRole('operator') }, async (request, reply) => {
    const { rows } = await fastify.pg.query(
      `SELECT id, device_id, content, content_hash, vendor, captured_at
         FROM device_configs WHERE id = $1 AND tenant_id = $2`,
      [request.params.id, request.user.tenantId]);
    if (!rows[0]) return reply.code(404).send({ error: 'no such version' });
    return { version: rows[0] };
  });

  /**
   * Diff two versions. With no `from`, the device's approved baseline is
   * used — which is the comparison an operator investigating drift actually
   * wants, rather than the previous capture.
   */
  fastify.get('/:deviceId/diff', {
    schema: DEVICE_PARAM,
    preHandler: fastify.requireRole('operator'),
  }, async (request, reply) => {
    const { deviceId } = request.params;
    const { from, to } = request.query ?? {};

    const load = async (id) => {
      const { rows } = await fastify.pg.query(
        `SELECT id, content, content_hash, captured_at FROM device_configs
          WHERE id = $1 AND device_id = $2 AND tenant_id = $3`,
        [id, deviceId, request.user.tenantId]);
      return rows[0] ?? null;
    };

    let before;
    if (from) {
      before = await load(from);
    } else {
      const { rows } = await fastify.pg.query(
        `SELECT c.id, c.content, c.content_hash, c.captured_at
           FROM config_baselines b JOIN device_configs c ON c.id = b.config_id
          WHERE b.device_id = $1 AND b.tenant_id = $2`,
        [deviceId, request.user.tenantId]);
      before = rows[0] ?? null;
    }

    let after;
    if (to) {
      after = await load(to);
    } else {
      const { rows } = await fastify.pg.query(
        `SELECT id, content, content_hash, captured_at FROM device_configs
          WHERE device_id = $1 AND tenant_id = $2 ORDER BY captured_at DESC LIMIT 1`,
        [deviceId, request.user.tenantId]);
      after = rows[0] ?? null;
    }

    if (!after) return reply.code(404).send({ error: 'no captured configuration for this device' });
    if (!before) {
      return {
        from: null, to: { id: after.id, capturedAt: after.captured_at },
        note: 'no baseline approved and no from= given — nothing to compare against',
        diff: { truncated: false, added: 0, removed: 0, hunks: [] },
      };
    }

    return {
      from: { id: before.id, capturedAt: before.captured_at },
      to: { id: after.id, capturedAt: after.captured_at },
      diff: diffConfigs(before.content, after.content),
    };
  });

  /**
   * Approve a version as the device's baseline.
   *
   * Deliberately an explicit act rather than "the newest version wins": if a
   * device drifted last week and the newest capture silently became its own
   * baseline, the drift check would report compliance forever and mean
   * nothing at all.
   */
  fastify.post('/:deviceId/approve', {
    schema: {
      ...DEVICE_PARAM,
      body: {
        type: 'object',
        required: ['configId'],
        properties: {
          configId: { type: 'string', format: 'uuid' },
          note: { type: 'string', maxLength: 500 },
        },
        additionalProperties: false,
      },
    },
    preHandler: fastify.requireRole('operator'),
  }, async (request, reply) => {
    const { rows: version } = await fastify.pg.query(
      `SELECT id, content_hash FROM device_configs
        WHERE id = $1 AND device_id = $2 AND tenant_id = $3`,
      [request.body.configId, request.params.deviceId, request.user.tenantId]);
    if (!version[0]) return reply.code(404).send({ error: 'no such version for this device' });

    const { rows } = await fastify.pg.query(
      `INSERT INTO config_baselines
         (device_id, tenant_id, config_id, content_hash, approved_by, note)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (device_id) DO UPDATE
         SET config_id = EXCLUDED.config_id, content_hash = EXCLUDED.content_hash,
             approved_by = EXCLUDED.approved_by, approved_at = now(), note = EXCLUDED.note
       RETURNING *`,
      [request.params.deviceId, request.user.tenantId, version[0].id, version[0].content_hash,
        request.user.sub ?? null, request.body.note ?? '']);
    return { baseline: rows[0] };
  });

  /* ── which devices are backed up ──────────────────────────────────── */

  fastify.get('/targets', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    const { rows } = await fastify.pg.query(
      `SELECT t.device_id, d.name AS device_name, t.vendor, t.command,
              t.volatile_extra, t.enabled, t.created_at
         FROM config_targets t JOIN devices d ON d.id = t.device_id
        WHERE t.tenant_id = $1 ORDER BY d.name`,
      [request.user.tenantId]);
    return { targets: rows };
  });

  fastify.post('/targets', {
    schema: {
      body: {
        type: 'object',
        required: ['deviceId'],
        properties: {
          deviceId: { type: 'string', format: 'uuid' },
          vendor: { type: 'string', maxLength: 40 },
          credentialId: { type: 'string', format: 'uuid', nullable: true },
          command: { type: 'string', maxLength: 300 },
          volatileExtra: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 200 } },
          enabled: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    // Admin: enabling backup points privileged credentials at a device, and
    // that is not an operator-level decision.
    preHandler: fastify.requireRole('admin'),
  }, async (request, reply) => {
    const b = request.body;
    if (b.vendor && !VENDOR_PROFILES[b.vendor]) {
      return reply.code(400).send({
        error: `unknown vendor; expected one of ${Object.keys(VENDOR_PROFILES).join(', ')}`,
      });
    }
    for (const pattern of b.volatileExtra ?? []) {
      try { new RegExp(pattern); }
      catch { return reply.code(400).send({ error: `"${pattern}" is not a valid regular expression` }); }
    }

    const { rows } = await fastify.pg.query(
      `INSERT INTO config_targets
         (device_id, tenant_id, vendor, credential_id, command, volatile_extra, enabled)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
       ON CONFLICT (device_id) DO UPDATE
         SET vendor = EXCLUDED.vendor, credential_id = EXCLUDED.credential_id,
             command = EXCLUDED.command, volatile_extra = EXCLUDED.volatile_extra,
             enabled = EXCLUDED.enabled
       RETURNING *`,
      [b.deviceId, request.user.tenantId, b.vendor ?? 'generic', b.credentialId ?? null,
        b.command ?? '', JSON.stringify(b.volatileExtra ?? []), b.enabled ?? true]);
    return reply.code(201).send({ target: rows[0] });
  });

  fastify.delete('/targets/:deviceId', {
    schema: DEVICE_PARAM,
    preHandler: fastify.requireRole('admin'),
  }, async (request, reply) => {
    // The captured history is deliberately kept: turning backup off is not a
    // request to destroy the record of what the device used to be.
    const { rowCount } = await fastify.pg.query(
      `DELETE FROM config_targets WHERE device_id = $1 AND tenant_id = $2`,
      [request.params.deviceId, request.user.tenantId]);
    if (!rowCount) return reply.code(404).send({ error: 'no such target' });
    return reply.code(204).send();
  });
}
