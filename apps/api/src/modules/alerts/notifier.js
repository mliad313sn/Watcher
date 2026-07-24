/**
 * Notification / dispatch engine (issue #5).
 *
 * Subscribes to the correlated alert stream and actually tells humans when
 * something breaks — the job the platform previously never did. For each
 * newly actionable alert it:
 *
 *   1. skips non-actionable states (suppressed / acknowledged / in-downtime) so
 *      maintenance and dependency-suppressed alerts never page,
 *   2. evaluates the tenant's `alert_rules` (severity threshold + optional match
 *      on device kind / tags),
 *   3. throttles per (tenant, device, check) so a flapping or repeatedly-updated
 *      alert pages once per cooldown, not once per event,
 *   4. dispatches via pluggable channel adapters (webhook, slack, log; email via
 *      an external gateway URL), recording every attempt in `notification_log`.
 *
 * Recovery notices are sent when a previously-notified alert resolves.
 */
import { REDIS_KEYS, SEVERITY_WEIGHT } from '@watcher/shared';

export class NotifierEngine {
  /**
   * @param {object} deps { redis, redisSub, pg, log }
   * @param {object} opts { cooldownS, fallbackWebhook, fetchImpl }
   */
  constructor({ redis, redisSub, pg, log }, opts = {}) {
    this.redis = redis;
    this.redisSub = redisSub;
    this.pg = pg;
    this.log = log;
    this.cooldownS = opts.cooldownS ?? 300;
    this.fallbackWebhook = opts.fallbackWebhook ?? '';
    this.fetch = opts.fetchImpl ?? fetch;
    this.handler = null;
    this._rulesCache = new Map(); // tenantId -> { rules, at }
  }

  async start() {
    await this.redisSub.subscribe(REDIS_KEYS.eventsAlerts);
    this.handler = (channel, message) => {
      if (channel !== REDIS_KEYS.eventsAlerts) return;
      this.#handle(JSON.parse(message)).catch((err) => this.log.error({ err }, 'notify failed'));
    };
    this.redisSub.on('message', this.handler);
    this.log.info({ cooldownS: this.cooldownS }, 'notifier engine started');
  }

  async stop() {
    if (this.handler) this.redisSub.off('message', this.handler);
  }

  async #handle({ action, alert }) {
    if (!alert) return;

    if (action === 'resolved') {
      // Only send a recovery notice if we actually paged for this incident.
      const key = REDIS_KEYS.notifyThrottle(alert.tenant_id, `${alert.device_name}/${alert.check_name}`);
      const wasNotified = await this.redis.get(key);
      if (wasNotified) {
        await this.redis.del(key);
        await this.#dispatchAll(alert, 'recovery');
      }
      return;
    }

    // Only page on a genuinely new/escalated, actionable problem.
    if (action !== 'raised' && action !== 'escalated') return;
    if (alert.status !== 'open') return; // suppressed / acknowledged / downtime → no page

    // Throttle: one page per incident per cooldown. Escalations bypass the
    // throttle so a warning→critical jump always re-pages.
    const throttleKey = REDIS_KEYS.notifyThrottle(alert.tenant_id, `${alert.device_name}/${alert.check_name}`);
    if (action !== 'escalated') {
      const fresh = await this.redis.set(throttleKey, '1', 'EX', this.cooldownS, 'NX');
      if (fresh === null) return; // already paged within the cooldown window
    } else {
      await this.redis.set(throttleKey, '1', 'EX', this.cooldownS);
    }

    await this.#dispatchAll(alert, action === 'escalated' ? 'escalation' : 'alert');
  }

  async #dispatchAll(alert, kind) {
    const rules = await this.#rulesFor(alert.tenant_id);
    const device = alert.device_id ? await this.#device(alert.device_id) : null;

    const matched = rules.filter((r) => this.#matches(r, alert, device));
    const targets = matched.flatMap((r) => (Array.isArray(r.actions) ? r.actions : []).map((a) => ({ rule: r, action: a })));

    // A configured fallback webhook receives everything, even with no rules —
    // so a fresh install still pages somewhere instead of silently dropping.
    if (this.fallbackWebhook) {
      targets.push({ rule: { id: null }, action: { type: 'webhook', url: this.fallbackWebhook } });
    }

    if (targets.length === 0) {
      this.log.warn({ alert: alert.id, severity: alert.severity },
        'alert matched no notification rule and no fallback webhook is set — not dispatched');
      return;
    }

    for (const { rule, action } of targets) {
      await this.#dispatch(action, alert, kind, rule.id);
    }
  }

  async #dispatch(action, alert, kind, ruleId) {
    const title = kind === 'recovery'
      ? `RESOLVED: ${alert.device_name}${alert.check_name ? ' / ' + alert.check_name : ''}`
      : `[${alert.severity.toUpperCase()}] ${alert.device_name}${alert.check_name ? ' / ' + alert.check_name : ''}`;
    const body = { title, kind, alert };

    let status = 'sent';
    let error = null;
    try {
      switch (action.type) {
        case 'webhook':
          await this.#post(action.url, body);
          break;
        case 'slack':
          await this.#post(action.url, { text: `${title}\n${alert.message}` });
          break;
        case 'email':
          // No SMTP client is bundled; email is delivered via an external
          // mail-gateway webhook if configured, otherwise flagged for setup.
          if (action.gatewayUrl) await this.#post(action.gatewayUrl, { to: action.to, subject: title, text: alert.message });
          else { status = 'skipped'; error = 'email requires action.gatewayUrl (SMTP not bundled)'; }
          break;
        case 'log':
          this.log.warn({ alert: alert.id }, `NOTIFY ${title}: ${alert.message}`);
          break;
        default:
          status = 'skipped';
          error = `unknown action type: ${action.type}`;
      }
    } catch (err) {
      status = 'failed';
      error = String(err?.message ?? err);
      this.log.error({ err, action: action.type }, 'notification dispatch failed');
    }

    await this.pg.query(
      `INSERT INTO notification_log (alert_id, rule_id, channel, target, status, error)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [alert.id, ruleId, action.type, action.url ?? action.to ?? '', status, error],
    ).catch((err) => this.log.warn({ err }, 'notification_log insert failed'));
  }

  async #post(url, payload) {
    if (!url) throw new Error('missing url');
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  #matches(rule, alert, device) {
    if (SEVERITY_WEIGHT[alert.severity] < SEVERITY_WEIGHT[rule.min_severity]) return false;
    const m = rule.match ?? {};
    if (m.kind && device?.kind !== m.kind) return false;
    if (m.tags && device) {
      for (const [k, v] of Object.entries(m.tags)) {
        if ((device.tags ?? {})[k] !== v) return false;
      }
    }
    return true;
  }

  async #rulesFor(tenantId) {
    const cached = this._rulesCache.get(tenantId);
    if (cached && Date.now() - cached.at < 30_000) return cached.rules;
    const { rows } = await this.pg.query(
      'SELECT id, min_severity, match, actions FROM alert_rules WHERE tenant_id = $1 AND enabled',
      [tenantId],
    );
    this._rulesCache.set(tenantId, { rules: rows, at: Date.now() });
    return rows;
  }

  async #device(id) {
    const { rows } = await this.pg.query('SELECT kind, tags FROM devices WHERE id = $1', [id]);
    return rows[0] ?? null;
  }
}
