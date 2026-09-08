/**
 * The event pipeline: everything that happens between a receiver decoding a
 * datagram and the rest of Watcher finding out about it.
 *
 *   identify → rate-limit → store → decide → publish
 *
 * Both receivers (traps, syslog) hand normalised events to `handle()`. The
 * pipeline is deliberately the only place that knows about the database, the
 * rule set or Redis, so a receiver stays a parser with a socket attached and
 * can be tested as one.
 *
 * The last step publishes onto `watcher:events:state` — the same channel the
 * Nagios streamer writes — so an event-born alert goes through dedup,
 * dependency suppression, maintenance windows, on-call, runbooks and
 * escalation without any of those modules learning that events exist.
 */
import {
  REDIS_KEYS, RULE_ACTION, evaluateEvent, severityToServiceState,
  SERVICE_STATE, syslogSeverityHint,
} from '@watcher/shared';

/** How long a cached identity or rule set is trusted before re-reading. */
const RULES_TTL_MS = 30_000;
const SOURCE_TTL_MS = 60_000;

/**
 * Per-source admission control (RSK-45: "trap floods can overwhelm the alert
 * pipeline"). One flapping interface can emit thousands of traps a minute,
 * and the failure mode is not a slow dashboard — it is the alert pipeline
 * becoming the outage.
 *
 * A fixed window per source, counted in memory. Over the ceiling the events
 * are dropped and counted, and ONE synthetic event is emitted saying the
 * source was throttled, so the silence is visible rather than mysterious.
 */
export class RateLimiter {
  constructor({ limit = 200, windowMs = 60_000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.buckets = new Map();
  }

  /** @returns {{allowed: boolean, dropped: number, firstDrop: boolean}} */
  admit(key, now = Date.now()) {
    let b = this.buckets.get(key);
    if (!b || now >= b.until) {
      b = { n: 0, dropped: 0, until: now + this.windowMs };
      this.buckets.set(key, b);
    }
    // An unbounded map is its own denial of service; a spoofed source
    // address is free to invent.
    if (this.buckets.size > 10_000) this.#evict(now);

    if (b.n < this.limit) { b.n++; return { allowed: true, dropped: 0, firstDrop: false }; }
    b.dropped++;
    return { allowed: false, dropped: b.dropped, firstDrop: b.dropped === 1 };
  }

  #evict(now) {
    for (const [k, v] of this.buckets) if (now >= v.until) this.buckets.delete(k);
    if (this.buckets.size > 10_000) this.buckets.clear();
  }
}

export class EventPipeline {
  /**
   * @param {object} deps
   * @param {import('pg').Pool} deps.pg    configuration database
   * @param {import('pg').Pool} deps.tsdb  metrics/event store
   * @param {import('ioredis').Redis} deps.redis
   * @param {object} deps.log
   * @param {object} [deps.limits] rate-limiter options
   */
  constructor({ pg, tsdb, redis, log, limits }) {
    this.pg = pg;
    this.tsdb = tsdb;
    this.redis = redis;
    this.log = log;
    this.limiter = new RateLimiter(limits);
    this.rules = { at: 0, byTenant: new Map() };
    this.sources = { at: 0, byAddress: new Map() };
    this.tenantId = null;
    this.stats = { received: 0, stored: 0, raised: 0, cleared: 0, dropped: 0, throttled: 0 };
  }

  /**
   * The tenant an event belongs to. Events arrive on a socket, and a socket
   * carries no tenant — so the source address decides, falling back to the
   * default tenant. A multi-tenant deployment that shares one receiver
   * address must map its sources explicitly; that is a deliberate refusal to
   * guess, because guessing wrong here leaks one customer's events to
   * another.
   */
  async #defaultTenant() {
    if (this.tenantId) return this.tenantId;
    const { rows } = await this.pg.query('SELECT id FROM tenants ORDER BY created_at LIMIT 1');
    this.tenantId = rows[0]?.id ?? null;
    return this.tenantId;
  }

  /** Address → device identity, from inventory and from the allow-list. */
  async #identify(address) {
    const now = Date.now();
    if (now - this.sources.at > SOURCE_TTL_MS) {
      const map = new Map();
      // The allow-list wins over inventory: it exists precisely to describe
      // the cases inventory gets wrong (loopback senders, relays).
      const { rows: devices } = await this.pg.query(
        `SELECT id, tenant_id, name, address FROM devices WHERE address IS NOT NULL`);
      for (const d of devices) {
        map.set(String(d.address), {
          deviceId: d.id, tenantId: d.tenant_id, deviceName: d.name, known: true,
        });
      }
      const { rows: sources } = await this.pg.query(
        `SELECT s.address, s.device_id, s.tenant_id, s.label, s.enabled, d.name AS device_name
           FROM event_sources s LEFT JOIN devices d ON d.id = s.device_id`);
      for (const s of sources) {
        map.set(String(s.address), {
          deviceId: s.device_id, tenantId: s.tenant_id,
          deviceName: s.device_name || s.label || String(s.address),
          known: true, enabled: s.enabled,
        });
      }
      this.sources = { at: now, byAddress: map };
    }
    const hit = this.sources.byAddress.get(address);
    if (hit) return hit;
    return {
      deviceId: null, tenantId: await this.#defaultTenant(),
      deviceName: address, known: false, enabled: true,
    };
  }

  /** The rule set for a tenant, re-read on a short timer. */
  async #rulesFor(tenantId) {
    const now = Date.now();
    if (now - this.rules.at > RULES_TTL_MS) {
      const { rows } = await this.pg.query(
        `SELECT id, tenant_id, name, source, enabled, priority, match_oid, match_pattern,
                match_app, match_facility, max_severity, action, severity, check_name,
                auto_clear_seconds
           FROM event_rules WHERE enabled ORDER BY priority, id`);
      const byTenant = new Map();
      for (const r of rows) {
        const list = byTenant.get(r.tenant_id) ?? [];
        list.push({
          id: r.id, name: r.name, source: r.source ?? 'any', enabled: r.enabled,
          priority: r.priority, matchOid: r.match_oid, matchPattern: r.match_pattern,
          matchApp: r.match_app, matchFacility: r.match_facility,
          maxSeverity: r.max_severity, action: r.action, severity: r.severity,
          checkName: r.check_name, autoClearSeconds: r.auto_clear_seconds,
        });
        byTenant.set(r.tenant_id, list);
      }
      this.rules = { at: now, byTenant };
    }
    return this.rules.byTenant.get(tenantId) ?? [];
  }

  /** Drop the caches — called by the API after a rule or source is edited. */
  invalidate() {
    this.rules.at = 0;
    this.sources.at = 0;
  }

  /**
   * Take one normalised event through the pipeline.
   *
   * @param {object} event  {source, sourceIp, oid, facility, severity,
   *                         facilityName, severityName, appName, message,
   *                         detail, timestamp}
   */
  async handle(event) {
    this.stats.received++;
    try {
      const identity = await this.#identify(event.sourceIp);
      if (identity.enabled === false) { this.stats.dropped++; return null; }

      const admission = this.limiter.admit(event.sourceIp);
      if (!admission.allowed) {
        this.stats.throttled++;
        // Say it once per window. A throttle that is itself silent is
        // indistinguishable from a device that stopped talking.
        if (admission.firstDrop) {
          this.log.warn({ source: event.sourceIp, limit: this.limiter.limit },
            'event source throttled — dropping until the window rolls');
          await this.#store({
            ...event, ...identity,
            message: `Event source ${event.sourceIp} exceeded ${this.limiter.limit} events/minute; further events dropped this window`,
            severity: 4,
          }, { action: RULE_ACTION.LOG, checkName: 'event throttle', ruleId: null, ruleName: '' })
            .catch(() => {});
        }
        return null;
      }

      const full = { ...event, ...identity };
      const rules = await this.#rulesFor(identity.tenantId);
      const decision = evaluateEvent(rules, full);

      if (decision.action === RULE_ACTION.DROP) { this.stats.dropped++; return null; }

      await this.#store(full, decision);
      this.stats.stored++;

      if (decision.action === RULE_ACTION.ALERT) {
        // An unidentified source may fill the event log — it may not page.
        // Alert injection from a spoofed address is the whole reason the
        // allow-list exists (ISS-25 on the delivery register).
        if (!identity.known) {
          this.log.warn({ source: event.sourceIp, check: decision.checkName },
            'event from an unknown source matched a raising rule — logged, not raised');
          return decision;
        }
        await this.#raise(full, decision);
        this.stats.raised++;
      } else if (decision.action === RULE_ACTION.CLEAR) {
        await this.#clear(full, decision);
        this.stats.cleared++;
      }
      return decision;
    } catch (err) {
      this.log.error({ err, source: event.sourceIp }, 'event pipeline failed');
      return null;
    }
  }

  async #store(event, decision) {
    await this.tsdb.query(
      `INSERT INTO events
         (time, tenant_id, source, device_id, device_name, source_ip, oid,
          facility, severity, app_name, message, detail, rule_id, rule_name,
          action, check_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [event.timestamp ?? new Date(), event.tenantId, event.source,
        event.deviceId ?? null, event.deviceName ?? '', event.sourceIp ?? null,
        event.oid ?? '', event.facility ?? null, event.severity ?? null,
        event.appName ?? '', String(event.message ?? '').slice(0, 8192),
        event.detail ? JSON.stringify(event.detail) : null,
        decision.ruleId, decision.ruleName, decision.action, decision.checkName]);
  }

  /**
   * Publish the event as a state change. The shape matches what the Nagios
   * streamer emits, field for field — that is not a coincidence, it is the
   * contract that keeps one alert model in the product.
   */
  async #raise(event, decision) {
    const state = severityToServiceState(decision.severity);
    await this.#publishState(event, decision, state);

    if (decision.autoClearSeconds) await this.#scheduleAutoClear(event, decision);
  }

  async #clear(event, decision) {
    await this.#publishState(event, decision, SERVICE_STATE.OK);
  }

  async #publishState(event, decision, state) {
    await this.redis.publish(REDIS_KEYS.eventsState, JSON.stringify({
      host: event.deviceName,
      service: decision.checkName,
      kind: 'service',
      state,
      hard: true,               // an event has already happened; there is no retry
      output: String(event.message ?? '').slice(0, 1024),
      tenantId: event.tenantId,
      prevState: null,
      ts: Date.now(),
      // Provenance, so the console can say "this came from a trap" and the
      // notifier can put the rule's name in the page.
      origin: event.source,
      originRule: decision.ruleName,
    }));
  }

  /**
   * Record the deadline by which an event-born alert closes itself. The row
   * is written against whichever alert the correlation engine ends up
   * opening for this (device, check) — so the write is deferred just far
   * enough for that row to exist, and is idempotent if it already does.
   */
  async #scheduleAutoClear(event, decision) {
    const at = new Date(Date.now() + decision.autoClearSeconds * 1000);
    // The correlation engine opens the alert on the same event we just
    // published; a short retry loop is simpler and more honest than a
    // distributed handshake for something this small.
    for (let attempt = 0; attempt < 5; attempt++) {
      const { rowCount } = await this.pg.query(
        `INSERT INTO alert_auto_clear (alert_id, clear_at, rule_id)
         SELECT id, $3, $4 FROM alerts
          WHERE tenant_id = $1 AND device_name = $2 AND check_name = $5
            AND status IN ('open','acknowledged','suppressed')
          ON CONFLICT (alert_id) DO UPDATE SET clear_at = EXCLUDED.clear_at`,
        [event.tenantId, event.deviceName, at, decision.ruleId, decision.checkName]);
      if (rowCount > 0) return;
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
    this.log.debug({ check: decision.checkName },
      'no alert row to attach an auto-clear deadline to');
  }

  /** Severity to colour an unmatched syslog line with in the console. */
  static hint(severity) { return syslogSeverityHint(severity); }
}
