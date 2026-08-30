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
 *      an external gateway URL; `oncall` resolves to whoever is on call now),
 *      recording every attempt in `notification_log`.
 *
 * Recovery notices are sent when a previously-notified alert resolves.
 */
import { REDIS_KEYS, SEVERITY_WEIGHT } from '@watcher/shared';
import { currentOnCall } from '../oncall/store.js';
import { runbookForAlert } from '../runbooks/store.js';
import { activeWindowFor } from '../maintenance/routes.js';

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
    this.sweepMs = opts.sweepMs ?? 30_000;
    // One-tap mobile acknowledge: sign a per-alert capability token and put
    // an ack link in every page, so the responder can ack from their phone.
    this.ackBaseUrl = opts.ackBaseUrl ?? '';
    this.signAckToken = opts.signAckToken ?? null;
    this.handler = null;
    this.sweepTimer = null;
    this._rulesCache = new Map(); // tenantId -> { rules, at }
  }

  async start() {
    await this.redisSub.subscribe(REDIS_KEYS.eventsAlerts);
    this.handler = (channel, message) => {
      if (channel !== REDIS_KEYS.eventsAlerts) return;
      let event;
      try { event = JSON.parse(message); }
      catch { this.log.warn('dropped malformed alert event on bus'); return; }
      this.#handle(event).catch((err) => this.log.error({ err }, 'notify failed'));
    };
    this.redisSub.on('message', this.handler);

    // Acknowledgement-SLA escalation: sweep for critical alerts nobody has
    // acknowledged within their rule window and escalate them (issue: on-call
    // keystone). This is what makes the tool a safety net, not just a board.
    this.sweepTimer = setInterval(() => {
      this.#escalationSweep().catch((err) => this.log.error({ err }, 'escalation sweep failed'));
    }, this.sweepMs);
    this.sweepTimer.unref();

    this.log.info({ cooldownS: this.cooldownS, sweepMs: this.sweepMs }, 'notifier engine started');
  }

  async stop() {
    if (this.handler) this.redisSub.off('message', this.handler);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /**
   * Escalate critical alerts still `open` (i.e. unacknowledged) past a rule's
   * `escalate_after_s`. Each alert escalates at most once (`escalated_at`).
   */
  async #escalationSweep() {
    const { rows: alerts } = await this.pg.query(
      `SELECT * FROM alerts
       WHERE status = 'open' AND severity = 'critical' AND escalated_at IS NULL
       ORDER BY opened_at ASC LIMIT 200`);
    if (alerts.length === 0) return;

    for (const alert of alerts) {
      const rules = await this.#rulesFor(alert.tenant_id);
      const device = alert.device_id ? await this.#device(alert.device_id) : null;
      const ageS = (Date.now() - new Date(alert.opened_at).getTime()) / 1000;

      const due = rules.filter((r) =>
        r.escalate_after_s != null
        && ageS >= r.escalate_after_s
        && this.#matches(r, alert, device)
        && Array.isArray(r.escalation_actions) && r.escalation_actions.length > 0);
      if (due.length === 0) continue;

      // Claim the alert atomically so a second API instance can't double-page.
      const claim = await this.pg.query(
        `UPDATE alerts SET escalated_at = now()
         WHERE id = $1 AND escalated_at IS NULL AND status = 'open' RETURNING id`,
        [alert.id]);
      if (claim.rowCount === 0) continue;

      this.log.warn({ alert: alert.id, ageS: Math.round(ageS) },
        'escalating unacknowledged critical alert');
      for (const rule of due) {
        for (const action of rule.escalation_actions) {
          await this.#dispatch(action, alert, 'escalation', rule.id);
        }
      }
    }
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

    // Planned maintenance: the alert still exists and records (history stays
    // honest) but nobody gets paged for work they scheduled themselves.
    // Recovery notices still go out so a window never eats an all-clear.
    if (kind !== 'recovery') {
      try {
        const win = await activeWindowFor(this.pg, alert, device ?? { name: alert.device_name });
        if (win) {
          this.log.info({ alert: alert.id, window: win.name },
            'notification suppressed: device under maintenance');
          await this.pg.query(
            `INSERT INTO notification_log (alert_id, rule_id, channel, target, status, error)
             VALUES ($1, NULL, 'maintenance', $2, 'suppressed', NULL)`,
            [alert.id, win.name]).catch(() => {});
          return;
        }
      } catch (err) {
        this.log.warn({ err }, 'maintenance-window check failed — paging anyway (fail open)');
      }
    }

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

    // A one-tap acknowledge link, valid only for this alert, on every page
    // except recovery notices.
    let ackUrl = null;
    let runbook = null;
    if (kind !== 'recovery') {
      if (this.signAckToken && this.ackBaseUrl) {
        try {
          ackUrl = `${this.ackBaseUrl}/ack.html?t=${this.signAckToken(alert.id, alert.tenant_id)}`;
        } catch { /* signing unavailable — pages still go out, just without the link */ }
      }
      // Enrich the page with remediation if a runbook applies.
      try { runbook = await runbookForAlert(this.pg, alert); } catch { /* best-effort */ }
    }
    const extra = { ackUrl, runbook };

    let status = 'sent';
    let error = null;
    let channel = action.type;
    let target = action.url ?? action.to ?? '';
    try {
      if (action.type === 'oncall') {
        // Resolve whoever is on call for this schedule and page THEM — this is
        // what turns escalation into a real on-call safety net.
        channel = 'oncall';
        const current = await currentOnCall(this.pg, action.scheduleId, alert.tenant_id);
        if (!current?.onCall) {
          status = 'skipped'; error = 'no one on call for schedule'; target = action.scheduleId ?? '';
        } else {
          const contact = current.onCall.contact ?? { type: 'log' };
          target = `${current.onCall.name} · ${contact.type ?? 'log'}`;
          const r = await this.#deliver(contact, title, alert, extra);
          if (r) { status = r.status; error = r.error; }
        }
      } else {
        const r = await this.#deliver(action, title, alert, extra);
        if (r) { status = r.status; error = r.error; }
      }
    } catch (err) {
      status = 'failed';
      error = String(err?.message ?? err);
      this.log.error({ err, action: action.type }, 'notification dispatch failed');
    }

    await this.pg.query(
      `INSERT INTO notification_log (alert_id, rule_id, channel, target, status, error)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [alert.id, ruleId, channel, target, status, error],
    ).catch((err) => this.log.warn({ err }, 'notification_log insert failed'));
  }

  /** Raw delivery for a concrete contact/action. Returns {status,error} for
   *  non-fatal outcomes, undefined when sent, throws on transport failure. */
  async #deliver(action, title, alert, extra = {}) {
    const { ackUrl = null, runbook = null } = extra;
    const rbLink = runbook?.links?.[0]?.url;
    const ackLine = ackUrl ? `\nAcknowledge: ${ackUrl}` : '';
    const rbLine = runbook ? `\nRunbook: ${runbook.name}${rbLink ? ' — ' + rbLink : ''}` : '';
    const rbSummary = runbook ? { name: runbook.name, steps: runbook.steps, links: runbook.links } : null;
    switch (action.type) {
      case 'webhook':
        await this.#post(action.url, { title, alert, ackUrl, runbook: rbSummary });
        return;
      case 'slack':
        await this.#post(action.url, { text: `${title}\n${alert.message}${ackLine}${rbLine}` });
        return;
      case 'email':
        // No SMTP client is bundled; email goes via an external mail-gateway
        // webhook if configured, otherwise it's flagged for setup.
        if (action.gatewayUrl) { await this.#post(action.gatewayUrl, { to: action.to, subject: title, text: `${alert.message}${ackLine}${rbLine}` }); return; }
        return { status: 'skipped', error: 'email requires action.gatewayUrl (SMTP not bundled)' };
      case 'teams':
        // Microsoft Teams incoming webhook (MessageCard). Facts render in the
        // card body; ack/runbook become tappable actions.
        await this.#post(action.url, {
          '@type': 'MessageCard', '@context': 'https://schema.org/extensions',
          summary: title,
          themeColor: alert.severity === 'critical' ? 'D93F4C' : alert.severity === 'warning' ? 'F0A030' : '4A8EFF',
          title,
          text: alert.message,
          sections: [{ facts: [
            { name: 'Device', value: alert.device_name },
            ...(alert.check_name ? [{ name: 'Check', value: alert.check_name }] : []),
            { name: 'Severity', value: alert.severity },
            ...(runbook ? [{ name: 'Runbook', value: runbook.name }] : []),
          ] }],
          potentialAction: [
            ...(ackUrl ? [{ '@type': 'OpenUri', name: 'Acknowledge', targets: [{ os: 'default', uri: ackUrl }] }] : []),
            ...(rbLink ? [{ '@type': 'OpenUri', name: 'Open runbook', targets: [{ os: 'default', uri: rbLink }] }] : []),
          ],
        });
        return;
      case 'pagerduty': {
        // PagerDuty Events API v2. dedup_key = alert id so re-notifies update
        // the same PD incident instead of stacking new ones.
        if (!action.routingKey) return { status: 'skipped', error: 'pagerduty requires action.routingKey' };
        await this.#post(action.url || 'https://events.pagerduty.com/v2/enqueue', {
          routing_key: action.routingKey,
          event_action: 'trigger',
          dedup_key: `watcher-${alert.id}`,
          payload: {
            summary: `${title}: ${alert.message}`.slice(0, 1024),
            source: alert.device_name,
            severity: alert.severity === 'warning' ? 'warning' : alert.severity === 'critical' ? 'critical' : 'info',
            component: alert.check_name || undefined,
            custom_details: { runbook: runbook?.name, ackUrl },
          },
          links: [
            ...(ackUrl ? [{ href: ackUrl, text: 'Acknowledge in Watcher' }] : []),
            ...(rbLink ? [{ href: rbLink, text: `Runbook: ${runbook.name}` }] : []),
          ],
        });
        return;
      }
      case 'log':
        this.log.warn({ alert: alert.id, ackUrl, runbook: runbook?.name }, `NOTIFY ${title}: ${alert.message}`);
        return;
      default:
        return { status: 'skipped', error: `unknown action type: ${action.type}` };
    }
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
      `SELECT id, min_severity, match, actions, escalate_after_s, escalation_actions
       FROM alert_rules WHERE tenant_id = $1 AND enabled`,
      [tenantId],
    );
    this._rulesCache.set(tenantId, { rules: rows, at: Date.now() });
    return rows;
  }

  async #device(id) {
    const { rows } = await this.pg.query('SELECT name, kind, tags FROM devices WHERE id = $1', [id]);
    return rows[0] ?? null;
  }
}
