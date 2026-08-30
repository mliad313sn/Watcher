/**
 * Demo seed engine — materialises the demo dataset across Postgres (inventory
 * + alerts + a routing rule), TimescaleDB (metrics + availability history) and
 * Redis (live state cache), so the whole product lights up at once.
 *
 * Idempotent and tenant-scoped: re-seeding refreshes in place, and clearDemo()
 * removes exactly what was seeded (demo-tagged devices, their alerts/metrics,
 * and the demo rule). Metric/history writes are best-effort so the demo still
 * populates inventory + state + alerts even if TimescaleDB is unavailable.
 */
import { REDIS_KEYS } from '@watcher/shared';
import { FLEET, SERVICES, METRICS, INTERFACES, series, metricShape, trafficShape } from './dataset.js';

const HOST_STATE_NAME = ['UP', 'DOWN', 'UNREACHABLE'];
const SVC_STATE_NAME = ['OK', 'WARNING', 'CRITICAL', 'UNKNOWN'];

export async function seedDemo({ pg, tsdb, redis, tenantId, log = console }) {
  const now = Date.now();

  // ── 1. Inventory (Postgres), tagged demo for clean teardown ───────────────
  const idByName = new Map();
  for (const d of FLEET) {
    const { rows } = await pg.query(
      `INSERT INTO devices (tenant_id, name, address, kind, vendor, model, location, tags, monitored)
       VALUES ($1, $2, $3::inet, $4::device_kind, $5, $6, $7, '{"demo": true}'::jsonb, true)
       ON CONFLICT (tenant_id, name) DO UPDATE SET
         address = EXCLUDED.address, kind = EXCLUDED.kind, vendor = EXCLUDED.vendor,
         model = EXCLUDED.model, location = EXCLUDED.location, tags = devices.tags || '{"demo": true}'::jsonb
       RETURNING id`,
      [tenantId, d.name, d.addr, d.kind, d.vendor, d.model, d.loc]);
    idByName.set(d.name, rows[0].id);
  }
  // Wire topology now that every device exists.
  for (const d of FLEET) {
    if (d.parent) {
      await pg.query('UPDATE devices SET parent_id = $2 WHERE id = $1',
        [idByName.get(d.name), idByName.get(d.parent)]);
    }
  }

  // ── 2. Live state cache (Redis) + freshness heartbeat ─────────────────────
  const pipe = redis.pipeline();
  const stamp = (obj, key) => {
    const sig = [obj.state, 1, obj.output].join('');
    pipe.hset(key, {
      kind: obj.kind, host: obj.host, service: obj.service ?? '', tenantId,
      state: obj.state, hard: 1, output: obj.output ?? '', perfData: '',
      lastCheck: Math.floor(now / 1000), lastStateChange: Math.floor((now - 20 * 60_000) / 1000),
      flapping: obj.flapping ? 1 : 0, acknowledged: obj.acknowledged ? 1 : 0,
      inDowntime: 0, sig,
    });
    pipe.sadd(REDIS_KEYS.stateIndex, key);
  };
  for (const d of FLEET) {
    stamp({ kind: 'host', host: d.name, state: d.state, output: `${HOST_STATE_NAME[d.state]} - ${d.loc}` },
      REDIS_KEYS.hostState(d.name));
  }
  for (const s of SERVICES) {
    stamp({
      kind: 'service', host: s.host, service: s.service, state: s.state, output: s.output,
      flapping: s.flag === 'flapping', acknowledged: s.flag === 'ack',
    }, REDIS_KEYS.serviceState(s.host, s.service));
  }
  // Fresh heartbeat so the "engine stale" self-check stays green in the demo.
  pipe.set(REDIS_KEYS.nagiosHeartbeat, String(now));
  await pipe.exec();

  // ── 3. Alerts (Postgres) — mirrors what correlation would produce ─────────
  await clearDemoAlerts(pg, tenantId);
  const demoHosts = FLEET.map((d) => d.name);

  // Root cause: the SFO distribution switch is down.
  const root = await insertAlert(pg, tenantId, idByName.get('dist-sw-sfo-01'), 'dist-sw-sfo-01', '',
    'critical', 'open', 'DOWN: CRITICAL - host unreachable (SFO uplink)', { occurrences: 1 });
  // A child behind it is suppressed under the root cause (the anti-storm story).
  await insertAlert(pg, tenantId, idByName.get('app-srv-sfo-03'), 'app-srv-sfo-03', 'HTTP',
    'critical', 'suppressed', 'CRITICAL - connection timed out', { suppressedBy: root.id });
  await insertAlert(pg, tenantId, idByName.get('db-cluster-01'), 'db-cluster-01', 'PostgreSQL',
    'critical', 'open', 'CRITICAL - CPU load 97% sustained 6m', { occurrences: 4 });
  await insertAlert(pg, tenantId, idByName.get('db-cluster-01'), 'db-cluster-01', 'Replication Lag',
    'warning', 'open', 'WARNING - replica lag 312s > 300s', {});
  await insertAlert(pg, tenantId, idByName.get('san-01'), 'san-01', 'Volume Space',
    'warning', 'acknowledged', 'WARNING - volume "prod" 8% free', { ackComment: 'capacity ticket OPS-4821 open' });
  await insertAlert(pg, tenantId, idByName.get('dist-sw-nyc-01'), 'dist-sw-nyc-01', 'BGP Session',
    'warning', 'open', 'WARNING - BGP flapped 3× in 10m (peer 10.0.4.254)', { flapping: true, occurrences: 6 });

  // ── 4. On-call rotation + a routing/escalation rule that pages it ─────────
  // A weekly NOC rotation of three responders (log contacts — no external
  // calls in the demo), so escalation resolves to "whoever is on call now".
  await pg.query(`DELETE FROM oncall_schedules WHERE tenant_id = $1 AND name = 'Demo — NOC rotation'`, [tenantId]);
  const sched = await pg.query(
    `INSERT INTO oncall_schedules (tenant_id, name, rotation_interval_s, handoff_at)
     VALUES ($1, 'Demo — NOC rotation', 604800, now() - interval '2 days') RETURNING id`, [tenantId]);
  const scheduleId = sched.rows[0].id;
  const responders = ['Dana (NOC lead)', 'Sam (on-call)', 'Amara (network)'];
  for (let i = 0; i < responders.length; i++) {
    await pg.query(
      `INSERT INTO oncall_participants (schedule_id, position, name, contact)
       VALUES ($1, $2, $3, '{"type":"log"}'::jsonb)`, [scheduleId, i, responders[i]]);
  }

  await pg.query(
    `INSERT INTO alert_rules (tenant_id, name, min_severity, actions, escalate_after_s, escalation_actions)
     VALUES ($1, 'Demo — critical routing', 'critical',
             '[{"type":"log"}]'::jsonb, 900, $2::jsonb)
     ON CONFLICT DO NOTHING`,
    [tenantId, JSON.stringify([{ type: 'oncall', scheduleId }])]);

  // ── 5. Metrics + availability history (TimescaleDB, best-effort) ──────────
  if (tsdb) {
    await seedMetrics(tsdb, idByName, now, log).catch((err) => log.warn?.({ err }, 'demo metrics skipped'));
    await seedHistory(tsdb, now, log).catch((err) => log.warn?.({ err }, 'demo history skipped'));
  }

  log.info?.({ devices: FLEET.length, services: SERVICES.length }, 'demo environment seeded');
  return { devices: FLEET.length, services: SERVICES.length, alerts: 6, hosts: demoHosts };
}

async function insertAlert(pg, tenantId, deviceId, name, check, severity, status, message, opts) {
  const { rows } = await pg.query(
    `INSERT INTO alerts (tenant_id, device_id, device_name, check_name, severity, status,
                         message, occurrences, flapping, suppressed_by, ack_comment, opened_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() - interval '18 minutes')
     RETURNING *`,
    [tenantId, deviceId, name, check, severity, status, message,
     opts.occurrences ?? 1, opts.flapping ?? false, opts.suppressedBy ?? null, opts.ackComment ?? null]);
  return rows[0];
}

async function seedMetrics(tsdb, idByName, now, log) {
  const rows = [];
  for (const d of FLEET) {
    const id = idByName.get(d.name);
    for (const metric of (METRICS[d.kind] ?? [])) {
      for (const p of series({ ...metricShape(d.name, metric), hours: 6, stepMin: 10, nowMs: now })) {
        rows.push([p.time, id, metric, '', p.value]);
      }
    }
    for (const ifName of (INTERFACES[d.name] ?? [])) {
      for (const dir of ['in', 'out']) {
        const metric = dir === 'in' ? 'if.in.bps' : 'if.out.bps';
        for (const p of series({ ...trafficShape(d.name, ifName, dir), hours: 6, stepMin: 10, nowMs: now })) {
          rows.push([p.time, id, metric, ifName, p.value]);
        }
      }
    }
  }
  // Chunked multi-row inserts, idempotent against the dedup index.
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const params = [];
    const tuples = chunk.map((r, j) => {
      const o = j * 5; params.push(r[0], r[1], r[2], r[3], r[4]);
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5})`;
    });
    await tsdb.query(
      `INSERT INTO metrics (time, device_id, metric, instance, value)
       VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`, params);
  }
  log.info?.({ rows: rows.length }, 'demo metrics seeded');
}

async function seedHistory(tsdb, now, log) {
  // A few hard transitions so the availability/SLA report has a story to tell.
  const changes = [
    ['db-cluster-01', 'PostgreSQL', 0, 2, now - 6 * 60_000],
    ['dist-sw-sfo-01', '', 0, 1, now - 20 * 60_000],
    ['san-01', 'Volume Space', 0, 1, now - 3 * 3600_000],
    ['dist-sw-nyc-01', 'BGP Session', 1, 0, now - 40 * 60_000],
    ['dist-sw-nyc-01', 'BGP Session', 0, 1, now - 12 * 60_000],
  ];
  const params = [];
  const tuples = changes.map((c, j) => {
    const o = j * 5; params.push(new Date(c[4]), c[0], c[1], c[2], c[3]);
    return `($${o + 1}, $${o + 2}, $${o + 3}, true, $${o + 4}, $${o + 5}, 'demo')`;
  });
  await tsdb.query(
    `INSERT INTO state_changes (time, device_name, check_name, hard, from_state, to_state, output)
     VALUES ${tuples.join(', ')}`, params);
  log.info?.('demo history seeded');
}

async function clearDemoAlerts(pg, tenantId) {
  const names = FLEET.map((d) => d.name);
  await pg.query(
    `DELETE FROM alerts WHERE tenant_id = $1 AND device_name = ANY($2)`, [tenantId, names]);
}

export async function clearDemo({ pg, tsdb, redis, tenantId, log = console }) {
  const { rows } = await pg.query(
    `SELECT id, name FROM devices WHERE tenant_id = $1 AND tags->>'demo' = 'true'`, [tenantId]);
  const ids = rows.map((r) => r.id);
  const names = rows.map((r) => r.name);

  await clearDemoAlerts(pg, tenantId);
  await pg.query(`DELETE FROM alert_rules WHERE tenant_id = $1 AND name LIKE 'Demo — %'`, [tenantId]);
  await pg.query(`DELETE FROM oncall_schedules WHERE tenant_id = $1 AND name LIKE 'Demo — %'`, [tenantId]);

  if (tsdb && ids.length) {
    await tsdb.query('DELETE FROM metrics WHERE device_id = ANY($1)', [ids]).catch(() => {});
    await tsdb.query('DELETE FROM state_changes WHERE device_name = ANY($1)', [names]).catch(() => {});
  }
  // Devices last (cascades poll_assignments, topology_links).
  await pg.query(`DELETE FROM devices WHERE tenant_id = $1 AND tags->>'demo' = 'true'`, [tenantId]);

  // Redis live state for the demo hosts/services.
  if (names.length) {
    const keys = [];
    for (const d of FLEET) keys.push(REDIS_KEYS.hostState(d.name));
    for (const s of SERVICES) keys.push(REDIS_KEYS.serviceState(s.host, s.service));
    const pipe = redis.pipeline();
    pipe.del(...keys);
    pipe.srem(REDIS_KEYS.stateIndex, ...keys);
    await pipe.exec();
  }
  log.info?.({ devices: ids.length }, 'demo environment cleared');
  return { removed: ids.length };
}

/** Is a demo currently loaded for this tenant? */
export async function demoStatus({ pg, tenantId }) {
  const { rows } = await pg.query(
    `SELECT count(*)::int AS n FROM devices WHERE tenant_id = $1 AND tags->>'demo' = 'true'`, [tenantId]);
  return { loaded: rows[0].n > 0, devices: rows[0].n };
}

export { HOST_STATE_NAME, SVC_STATE_NAME };
