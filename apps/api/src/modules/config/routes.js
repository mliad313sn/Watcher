/**
 * Config-as-code: export the tenant's monitoring configuration as one
 * reviewable JSON document, and import it back idempotently.
 *
 * The bundle covers the config plane only (devices, alert rules, runbooks,
 * on-call schedules, status components) — never state, alerts, metrics or
 * secrets. Natural keys (names) drive the upsert, so a bundle lives happily
 * in Git: export → review diff → import on another install.
 */

export default async function configRoutes(fastify) {
  fastify.get('/export', { preHandler: fastify.requireRole('admin') }, async (request) => {
    const t = request.user.tenantId;
    const q = (sql, params = [t]) => fastify.pg.query(sql, params).then((r) => r.rows);

    const [devices, rules, runbooks, schedules, participants, components] = await Promise.all([
      q(`SELECT name, kind, address, parent_id, tags, os, location, vendor, model, monitored
         FROM devices WHERE tenant_id = $1 ORDER BY name`),
      q(`SELECT name, min_severity, match, actions, escalate_after_s, escalation_actions, enabled
         FROM alert_rules WHERE tenant_id = $1 ORDER BY name`),
      q(`SELECT name, match, steps, links, priority
         FROM runbooks WHERE tenant_id = $1 ORDER BY name`),
      q(`SELECT id, name, rotation_interval_s, handoff_at, timezone
         FROM oncall_schedules WHERE tenant_id = $1 ORDER BY name`),
      q(`SELECT p.schedule_id, p.name, p.contact, p.position
         FROM oncall_participants p
         JOIN oncall_schedules s ON s.id = p.schedule_id
         WHERE s.tenant_id = $1 ORDER BY p.schedule_id, p.position`),
      q(`SELECT name, match, position
         FROM status_components WHERE tenant_id = $1 ORDER BY position, name`),
    ]);

    // Parent links ship as names, not ids, so the bundle is portable.
    const nameById = new Map();
    const deviceRows = await fastify.pg.query(
      'SELECT id, name FROM devices WHERE tenant_id = $1', [t]);
    for (const d of deviceRows.rows) nameById.set(d.id, d.name);

    return {
      watcherConfig: 1, // bundle format version
      exportedAt: new Date().toISOString(),
      devices: devices.map((d) => ({
        name: d.name, kind: d.kind, address: d.address,
        parent: d.parent_id ? nameById.get(d.parent_id) ?? null : null,
        tags: d.tags, os: d.os, location: d.location,
        vendor: d.vendor, model: d.model, monitored: d.monitored,
      })),
      alertRules: rules.map((r) => ({
        name: r.name, minSeverity: r.min_severity, match: r.match,
        actions: r.actions, escalateAfterS: r.escalate_after_s,
        escalationActions: r.escalation_actions, enabled: r.enabled,
      })),
      runbooks,
      oncallSchedules: schedules.map((s) => ({
        name: s.name, rotationIntervalS: s.rotation_interval_s,
        handoffAt: s.handoff_at, timezone: s.timezone,
        participants: participants.filter((p) => p.schedule_id === s.id)
          .map((p) => ({ name: p.name, contact: p.contact })),
      })),
      statusComponents: components,
    };
  });

  fastify.post('/import', {
    schema: {
      body: {
        type: 'object',
        required: ['watcherConfig'],
        properties: {
          watcherConfig: { type: 'integer', const: 1 },
          dryRun: { type: 'boolean', default: false },
          devices: { type: 'array' },
          alertRules: { type: 'array' },
          runbooks: { type: 'array' },
          oncallSchedules: { type: 'array' },
          statusComponents: { type: 'array' },
        },
      },
    },
    preHandler: fastify.requireRole('admin'),
  }, async (request) => {
    const t = request.user.tenantId;
    const b = request.body;
    const summary = { devices: 0, alertRules: 0, runbooks: 0, oncallSchedules: 0, statusComponents: 0 };
    const client = await fastify.pg.connect();
    try {
      await client.query('BEGIN');

      // Pass 1: devices without parents; pass 2: wire parents by name.
      for (const d of b.devices ?? []) {
        if (!d?.name) continue;
        await client.query(
          `INSERT INTO devices (tenant_id, name, kind, address, tags, os, location, vendor, model, monitored)
           VALUES ($1, $2, COALESCE($3,'server')::device_kind, $4,
                   COALESCE($5,'{}'::jsonb), $6, $7, $8, $9, COALESCE($10, true))
           ON CONFLICT (tenant_id, name) DO UPDATE
             SET kind = EXCLUDED.kind, address = EXCLUDED.address, tags = EXCLUDED.tags,
                 os = EXCLUDED.os, location = EXCLUDED.location,
                 vendor = EXCLUDED.vendor, model = EXCLUDED.model,
                 monitored = EXCLUDED.monitored`,
          [t, d.name, d.kind ?? null, d.address ?? null,
           d.tags ? JSON.stringify(d.tags) : null,
           d.os ?? null, d.location ?? null, d.vendor ?? null, d.model ?? null,
           d.monitored]);
        summary.devices++;
      }
      for (const d of b.devices ?? []) {
        if (!d?.name || !d.parent) continue;
        await client.query(
          `UPDATE devices SET parent_id =
             (SELECT id FROM devices WHERE tenant_id = $1 AND name = $3)
           WHERE tenant_id = $1 AND name = $2`,
          [t, d.name, d.parent]);
      }

      for (const r of b.alertRules ?? []) {
        if (!r?.name) continue;
        await client.query(
          `INSERT INTO alert_rules
             (tenant_id, name, min_severity, match, actions, escalate_after_s, escalation_actions, enabled)
           VALUES ($1, $2, COALESCE($3,'warning')::alert_severity, COALESCE($4,'{}'::jsonb),
                   COALESCE($5,'[]'::jsonb), $6, COALESCE($7,'[]'::jsonb), COALESCE($8, true))
           ON CONFLICT (tenant_id, name) DO UPDATE
             SET min_severity = EXCLUDED.min_severity, match = EXCLUDED.match,
                 actions = EXCLUDED.actions, escalate_after_s = EXCLUDED.escalate_after_s,
                 escalation_actions = EXCLUDED.escalation_actions, enabled = EXCLUDED.enabled`,
          [t, r.name, r.minSeverity ?? null,
           r.match ? JSON.stringify(r.match) : null,
           r.actions ? JSON.stringify(r.actions) : null,
           r.escalateAfterS ?? null,
           r.escalationActions ? JSON.stringify(r.escalationActions) : null,
           r.enabled]);
        summary.alertRules++;
      }

      for (const rb of b.runbooks ?? []) {
        if (!rb?.name) continue;
        await client.query(
          `INSERT INTO runbooks (tenant_id, name, match, steps, links, priority)
           VALUES ($1, $2, COALESCE($3,'{}'::jsonb), COALESCE($4,''), COALESCE($5,'[]'::jsonb), COALESCE($6,100))
           ON CONFLICT (tenant_id, name) DO UPDATE
             SET match = EXCLUDED.match, steps = EXCLUDED.steps,
                 links = EXCLUDED.links, priority = EXCLUDED.priority`,
          [t, rb.name, rb.match ? JSON.stringify(rb.match) : null, rb.steps ?? '',
           rb.links ? JSON.stringify(rb.links) : null, rb.priority ?? null]);
        summary.runbooks++;
      }

      for (const s of b.oncallSchedules ?? []) {
        if (!s?.name) continue;
        const { rows: srows } = await client.query(
          `INSERT INTO oncall_schedules (tenant_id, name, rotation_interval_s, handoff_at, timezone)
           VALUES ($1, $2, COALESCE($3, 604800), COALESCE($4, now()), COALESCE($5, 'UTC'))
           ON CONFLICT (tenant_id, name) DO UPDATE
             SET rotation_interval_s = EXCLUDED.rotation_interval_s,
                 handoff_at = EXCLUDED.handoff_at, timezone = EXCLUDED.timezone
           RETURNING id`,
          [t, s.name, s.rotationIntervalS ?? null, s.handoffAt ?? null, s.timezone ?? null]);
        const sid = srows[0].id;
        // Roster is replaced wholesale — order in the bundle IS the rotation.
        await client.query('DELETE FROM oncall_participants WHERE schedule_id = $1', [sid]);
        let pos = 0;
        for (const p of s.participants ?? []) {
          await client.query(
            `INSERT INTO oncall_participants (schedule_id, name, contact, position)
             VALUES ($1, $2, COALESCE($3,'{"type":"log"}'::jsonb), $4)`,
            [sid, p.name, p.contact ? JSON.stringify(p.contact) : null, pos++]);
        }
        summary.oncallSchedules++;
      }

      for (const c of b.statusComponents ?? []) {
        if (!c?.name) continue;
        await client.query(
          `INSERT INTO status_components (tenant_id, name, match, position)
           VALUES ($1, $2, COALESCE($3,'{}'::jsonb), COALESCE($4, 0))
           ON CONFLICT (tenant_id, name) DO UPDATE
             SET match = EXCLUDED.match, position = EXCLUDED.position`,
          [t, c.name, c.match ? JSON.stringify(c.match) : null, c.position ?? null]);
        summary.statusComponents++;
      }

      if (b.dryRun) {
        await client.query('ROLLBACK');
        return { ok: true, dryRun: true, wouldApply: summary };
      }
      await client.query('COMMIT');
      return { ok: true, applied: summary };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}
