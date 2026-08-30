/**
 * Nagios → Redis streamer.
 *
 * Watches status.dat, parses it, diffs every host/service against the Redis
 * state cache and:
 *
 *   1. updates the current-state hashes (watcher:state:host:* / :svc:*),
 *      pipelined and only when a meaningful field changed (signature diff),
 *   2. publishes state *changes* to the watcher:events:state channel,
 *   3. records hard transitions into the state_changes hypertable
 *      (availability/SLA reporting), plus a one-time baseline anchor on first
 *      sighting so history survives streamer restarts,
 *   4. evicts objects that disappeared from Nagios (no ghost inventory),
 *   5. tags every object with its tenant (resolved from the device inventory)
 *      so the read/stream path can enforce tenant isolation,
 *   6. maintains a freshness heartbeat and raises an INTERNAL alert when the
 *      monitoring engine goes stale — guarding against silent blindness.
 *
 * See issues #2, #3, #8, #10.
 */
import { stat, readFile } from 'node:fs/promises';
import { REDIS_KEYS, stateName, INTERNAL_DEVICE } from '@watcher/shared';
import { parseStatusDat, normalizeObject } from './status-parser.js';

const INTERNAL_CHECK = 'nagios-engine';

export class NagiosStreamer {
  /**
   * @param {object} deps
   * @param {import('ioredis').Redis} deps.redis
   * @param {import('pg').Pool} deps.pg     config plane (tenant map, internal alerts)
   * @param {import('pg').Pool} deps.tsdb   TimescaleDB pool (state_changes)
   * @param {object} deps.log
   * @param {object} opts                   config.nagios
   */
  constructor({ redis, pg, tsdb, log }, opts) {
    this.redis = redis;
    this.pg = pg;
    this.tsdb = tsdb;
    this.log = log;
    this.opts = opts;
    this.lastMtimeMs = 0;
    this.timer = null;
    this.running = false;
    this.stale = false;

    // Objects go stale if status.dat hasn't been rewritten in this long. Nagios
    // rewrites it every status_update_interval, so a few missed cycles = trouble.
    this.staleThresholdMs = opts.staleThresholdMs
      ?? Math.max(30_000, (opts.pollInterval ?? 5000) * 4);

    // host_name -> tenant_id, refreshed periodically so newly-added devices
    // land in the right tenant without a per-object DB hit.
    this.tenantByHost = new Map();
    this.defaultTenantId = null;
    this.tenantRefreshedAt = 0;
  }

  start() {
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log.error({ err }, 'nagios streamer tick failed'));
    }, this.opts.pollInterval);
    this.timer.unref();
    this.log.info({ file: this.opts.statusFile }, 'nagios streamer started');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async #refreshTenantMap() {
    // Cheap enough to run once a minute even for large inventories.
    if (Date.now() - this.tenantRefreshedAt < 60_000 && this.defaultTenantId) return;
    try {
      const [{ rows: devs }, { rows: tenants }] = await Promise.all([
        this.pg.query('SELECT name, tenant_id FROM devices'),
        this.pg.query('SELECT id FROM tenants ORDER BY created_at LIMIT 1'),
      ]);
      this.tenantByHost = new Map(devs.map((d) => [d.name, d.tenant_id]));
      this.defaultTenantId = tenants[0]?.id ?? null;
      this.tenantRefreshedAt = Date.now();
    } catch (err) {
      this.log.warn({ err }, 'tenant map refresh failed; using last known map');
    }
  }

  #tenantFor(host) {
    return this.tenantByHost.get(host) ?? this.defaultTenantId ?? '';
  }

  async tick() {
    if (this.running) return; // don't overlap slow ticks
    this.running = true;
    try {
      let fileStat;
      try {
        fileStat = await stat(this.opts.statusFile);
      } catch {
        // Only "stale" if the engine was previously alive and then went away.
        // A status file that has NEVER appeared (fresh install, Nagios not yet
        // wired, or a demo environment) is "not attached", not a fault — raising
        // a critical there is a false positive.
        if (this.lastMtimeMs > 0) {
          await this.#setStale(true, 'status.dat is not readable — Nagios engine down?');
        }
        return;
      }

      // Freshness / staleness is evaluated every tick, even when the file
      // content hasn't changed, so a wedged Nagios is detected promptly.
      const ageMs = Date.now() - fileStat.mtimeMs;
      await this.redis.set(REDIS_KEYS.nagiosHeartbeat, String(fileStat.mtimeMs));
      await this.#setStale(
        ageMs > this.staleThresholdMs,
        `status.dat not updated for ${Math.round(ageMs / 1000)}s (threshold ${Math.round(this.staleThresholdMs / 1000)}s)`,
      );

      if (fileStat.mtimeMs === this.lastMtimeMs) return; // no new data to diff
      this.lastMtimeMs = fileStat.mtimeMs;

      await this.#refreshTenantMap();

      const text = await readFile(this.opts.statusFile, 'utf8');
      const { hosts, services } = parseStatusDat(text);
      const parsed = [
        ...hosts.map((b) => normalizeObject(b, true)),
        ...services.map((b) => normalizeObject(b, false)),
      ];
      await this.#reconcile(parsed);
    } finally {
      this.running = false;
    }
  }

  /**
   * Diff the freshly-parsed objects against the cache in a small number of
   * pipelined round-trips, publish only real changes, and evict anything that
   * vanished from Nagios.
   */
  async #reconcile(parsed) {
    const keyOf = (obj) => (obj.kind === 'host'
      ? REDIS_KEYS.hostState(obj.host)
      : REDIS_KEYS.serviceState(obj.host, obj.service));

    // 1) One pipelined batch of reads for the previous state of every object.
    const readPipe = this.redis.pipeline();
    for (const obj of parsed) readPipe.hgetall(keyOf(obj));
    const readResults = await readPipe.exec();

    const writePipe = this.redis.pipeline();
    const events = [];
    const stateChanges = [];
    const seen = new Set();

    for (let i = 0; i < parsed.length; i++) {
      const obj = parsed[i];
      const key = keyOf(obj);
      seen.add(key);
      const prev = readResults[i]?.[1] ?? {};
      const prevState = prev.state === undefined ? null : Number(prev.state);
      const prevHard = prev.hard === '1';
      const tenantId = this.#tenantFor(obj.host);

      // Signature of the fields that actually matter for display/alerting —
      // skip the write entirely when nothing meaningful changed (issue #10).
      const sig = [obj.state, obj.hard ? 1 : 0, obj.output, obj.perfData,
        obj.flapping ? 1 : 0, obj.acknowledged ? 1 : 0, obj.inDowntime ? 1 : 0].join('');

      if (prev.sig !== sig || prev.tenantId !== tenantId) {
        writePipe.hset(key, {
          kind: obj.kind, host: obj.host, service: obj.service, tenantId,
          state: obj.state, hard: obj.hard ? 1 : 0, output: obj.output,
          perfData: obj.perfData, lastCheck: obj.lastCheck,
          lastStateChange: obj.lastStateChange, flapping: obj.flapping ? 1 : 0,
          acknowledged: obj.acknowledged ? 1 : 0, inDowntime: obj.inDowntime ? 1 : 0,
          sig,
        });
      }
      writePipe.sadd(REDIS_KEYS.stateIndex, key);

      const changed = prevState !== obj.state || prevHard !== obj.hard;
      if (changed) {
        events.push({
          ...obj, tenantId, prevState,
          stateName: stateName(obj.kind === 'host', obj.state),
          ts: Date.now(),
        });
        if (obj.hard && prevState !== null) {
          stateChanges.push({ obj, from: prevState });
        }
      }

      // First time we ever see this object (cache was empty): drop a baseline
      // anchor at Nagios's own last_state_change so availability windows that
      // span a streamer restart don't lose their starting state (issue #8).
      if (prevState === null && obj.hard) {
        stateChanges.push({ obj, from: obj.state, baseline: true });
      }
    }

    // 2) Evict objects that disappeared from Nagios (deleted host/service).
    // Guard: a parse with zero objects means Nagios isn't wired yet (status.dat
    // has only programstatus) or the file was caught mid-rewrite — NOT that the
    // whole estate vanished. Evicting on an empty parse would wipe demo/seeded
    // state and blank every dashboard, so we skip reconciliation-by-absence
    // entirely until we see at least one real object.
    const known = parsed.length > 0 ? await this.redis.smembers(REDIS_KEYS.stateIndex) : [];
    const stale = known.filter((k) => !seen.has(k));
    if (stale.length) {
      writePipe.srem(REDIS_KEYS.stateIndex, ...stale);
      writePipe.del(...stale);
      this.log.info({ evicted: stale.length }, 'evicted objects no longer in Nagios');
    }

    await writePipe.exec();

    // 3) Publish change events (pipelined publishes).
    if (events.length) {
      const pubPipe = this.redis.pipeline();
      for (const ev of events) pubPipe.publish(REDIS_KEYS.eventsState, JSON.stringify(ev));
      await pubPipe.exec();
    }

    // 4) Durable state-change history (single multi-row insert).
    if (stateChanges.length) await this.#writeStateChanges(stateChanges);
  }

  async #writeStateChanges(changes) {
    const params = [];
    const tuples = changes.map((c, i) => {
      const o = i * 6;
      // Baseline rows use the object's own last_state_change timestamp; real
      // transitions are stamped now().
      params.push(
        c.baseline ? new Date((c.obj.lastStateChange || Math.floor(Date.now() / 1000)) * 1000) : new Date(),
        c.obj.host, c.obj.service, c.from, c.obj.state, c.obj.output,
      );
      return `($${o + 1}, $${o + 2}, $${o + 3}, true, $${o + 4}, $${o + 5}, $${o + 6})`;
    });
    await this.tsdb.query(
      `INSERT INTO state_changes (time, device_name, check_name, hard, from_state, to_state, output)
       VALUES ${tuples.join(', ')}`,
      params,
    ).catch((err) => this.log.warn({ err }, 'state_changes insert failed'));
  }

  /** Raise/clear the platform's self-monitoring alert (silent-blindness guard). */
  async #setStale(isStale, reason) {
    if (isStale === this.stale) return; // edge-triggered
    const tenantId = this.defaultTenantId
      ?? (await this.pg.query('SELECT id FROM tenants ORDER BY created_at LIMIT 1')).rows[0]?.id;
    if (!tenantId) return;

    // Commit the flag only AFTER the DB write succeeds, so a transient failure
    // is retried on the next tick instead of being swallowed.
    if (isStale) {
      this.log.error({ reason }, 'MONITORING ENGINE STALE');
      const { rows } = await this.pg.query(
        `INSERT INTO alerts (tenant_id, device_name, check_name, severity, status, message)
         VALUES ($1, $2, $3, 'critical', 'open', $4)
         ON CONFLICT (tenant_id, device_name, check_name)
           WHERE status IN ('open', 'acknowledged', 'suppressed')
         DO UPDATE SET message = EXCLUDED.message, occurrences = alerts.occurrences + 1, updated_at = now()
         RETURNING *`,
        [tenantId, INTERNAL_DEVICE, INTERNAL_CHECK, `Monitoring engine stale: ${reason}`],
      );
      await this.#publishAlert('raised', rows[0]);
    } else {
      this.log.info('monitoring engine fresh again');
      const { rows } = await this.pg.query(
        `UPDATE alerts SET status = 'resolved', resolved_at = now()
         WHERE tenant_id = $1 AND device_name = $2 AND check_name = $3
           AND status IN ('open', 'acknowledged', 'suppressed')
         RETURNING *`,
        [tenantId, INTERNAL_DEVICE, INTERNAL_CHECK],
      );
      if (rows[0]) await this.#publishAlert('resolved', rows[0]);
    }
    this.stale = isStale;
  }

  async #publishAlert(action, alert) {
    if (!alert) return;
    await this.redis.publish(REDIS_KEYS.eventsAlerts, JSON.stringify({ action, alert }));
  }
}
