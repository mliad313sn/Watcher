/**
 * Proxy mode: the poller running at a remote site.
 *
 * Same connectors, same schedule, one difference — it reaches nothing but the
 * central API, and it reaches that outbound only. No inbound firewall rule,
 * no VPN, no database credentials at the site. That is the whole point: the
 * sites that most need monitoring are the ones nobody will open a port for.
 *
 *   central API ◄── HTTPS ──┤ proxy ├── SNMP/WMI/ICMP ──► the site's devices
 *
 * Three behaviours make it survivable:
 *
 *  · **Enrolment is once.** A one-time secret is exchanged for a durable
 *    credential on first start, and the secret is burned server-side in the
 *    same statement that issues the credential.
 *  · **Observations are buffered, not lost.** A proxy sits at the far end of
 *    exactly the link most likely to fail, so an unreachable API is a normal
 *    state. The buffer is bounded and drops the OLDEST first — after a long
 *    outage what matters is the site's current state, not a faithful replay
 *    of two days ago.
 *  · **Silence is reported by the other end.** The proxy heartbeats; the
 *    central watchdog raises when it stops. A proxy cannot be trusted to
 *    report its own death.
 */
import { ForwardBuffer, retryDelay } from '@watcher/shared';

export class ProxyAgent {
  /**
   * @param {object} opts
   * @param {string} opts.url        central API origin
   * @param {string} [opts.token]    durable credential (WATCHER_PROXY_TOKEN)
   * @param {string} [opts.enrol]    one-time secret, used when there is no token
   * @param {string} [opts.version]  agent version reported centrally
   * @param {object} deps {log, onAssignments, fetch}
   */
  constructor(opts, { log, onAssignments, fetch: fetchImpl = fetch }) {
    this.url = String(opts.url ?? '').replace(/\/$/, '');
    this.token = opts.token ?? null;
    this.enrol = opts.enrol ?? null;
    this.version = opts.version ?? '1.0.0-rc.1';
    this.log = log;
    this.onAssignments = onAssignments;
    this.fetch = fetchImpl;
    this.buffer = new ForwardBuffer({
      maxItems: Number(opts.maxBuffer ?? 50_000),
      batchSize: Number(opts.batchSize ?? 500),
    });
    this.failures = 0;
    this.timers = [];
    this.stopped = false;
    this.identity = null;
  }

  async #call(path, { method = 'GET', body, auth = true } = {}) {
    const res = await this.fetch(`${this.url}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(auth && this.token ? { 'x-proxy-token': this.token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const err = new Error(json?.error ?? `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  /**
   * Exchange the one-time secret for a durable credential.
   * The credential is returned rather than written anywhere: where a secret
   * lives at the site is the operator's decision (a file, a secret manager,
   * a systemd credential), not something this file should assume.
   */
  async enrolIfNeeded() {
    if (this.token) return { enrolled: false };
    if (!this.enrol) {
      throw new Error(
        'proxy mode needs WATCHER_PROXY_TOKEN, or WATCHER_PROXY_ENROL on first start');
    }
    const out = await this.#call('/api/proxy/enrol', {
      method: 'POST', auth: false,
      body: { secret: this.enrol, agentVersion: this.version },
    });
    this.token = out.proxyToken;
    this.identity = out.proxy;
    this.log.warn({ proxy: out.proxy.name },
      'enrolled — store the issued token as WATCHER_PROXY_TOKEN; it is not recoverable');
    return { enrolled: true, token: out.proxyToken, proxy: out.proxy };
  }

  /** Fetch the device list this proxy is responsible for. */
  async fetchAssignments() {
    const out = await this.#call('/api/proxy/assignments');
    this.identity = out.proxy;
    if (this.onAssignments) await this.onAssignments(out.devices);
    return out;
  }

  /** Queue observations for delivery. Never blocks on the network. */
  report({ metrics = [], states = [] }) {
    const items = [
      ...metrics.map((m) => ({ kind: 'metric', ...m })),
      ...states.map((s) => ({ kind: 'state', ...s })),
    ];
    return this.buffer.push(items);
  }

  /**
   * Deliver one batch. Returns true when something was delivered, so the
   * caller can drain a backlog quickly rather than one batch per tick.
   *
   * The batch is committed only on the server's answer — a proxy that
   * deletes on send loses exactly the observations that were in flight when
   * the link failed, which is the moment they matter most.
   */
  async flushOnce() {
    const batch = this.buffer.peek();
    if (!batch.length) return false;

    try {
      await this.#call('/api/proxy/report', {
        method: 'POST',
        body: {
          metrics: batch.filter((i) => i.kind === 'metric')
            .map(({ kind, ...m }) => m),
          states: batch.filter((i) => i.kind === 'state')
            .map(({ kind, ...s }) => s),
          queueDepth: this.buffer.size,
          agentVersion: this.version,
        },
      });
      this.buffer.commit(batch.length);
      this.failures = 0;
      return true;
    } catch (err) {
      // A rejected credential is not a transient failure and retrying it
      // forever hides the real problem from whoever is reading the log.
      if (err.status === 401) {
        this.log.error('proxy credential rejected — re-enrol this proxy');
        this.failures++;
        return false;
      }
      this.failures++;
      this.log.warn({ err: err.message, queued: this.buffer.size, attempt: this.failures },
        'delivery failed — observations are buffered');
      return false;
    }
  }

  async heartbeat() {
    try {
      await this.#call('/api/proxy/heartbeat', {
        method: 'POST',
        body: { queueDepth: this.buffer.size, agentVersion: this.version },
      });
      return true;
    } catch {
      return false;                        // the watchdog at the far end notices
    }
  }

  /** The delay before the next delivery attempt, jittered against the herd. */
  nextDelay() {
    return this.failures ? retryDelay(this.failures - 1) : 0;
  }

  async start({ flushMs = 15_000, heartbeatMs = 60_000, assignmentMs = 300_000 } = {}) {
    await this.enrolIfNeeded();
    await this.fetchAssignments();

    // Delivery paces itself: steady when healthy, backing off when not, and
    // draining a backlog as fast as the far end will take it.
    const pump = async () => {
      if (this.stopped) return;
      let delivered = true;
      let drained = 0;
      while (delivered && drained < 20 && !this.stopped) {
        delivered = await this.flushOnce();
        if (delivered) drained++;
      }
      const wait = this.failures ? this.nextDelay() : flushMs;
      this.timers.push(setTimeout(pump, wait).unref?.() ?? setTimeout(pump, wait));
    };
    pump();

    const beat = setInterval(() => this.heartbeat(), heartbeatMs);
    beat.unref();
    this.timers.push(beat);

    const refresh = setInterval(
      () => this.fetchAssignments().catch(
        (err) => this.log.warn({ err: err.message }, 'assignment refresh failed')),
      assignmentMs);
    refresh.unref();
    this.timers.push(refresh);

    this.log.info({ url: this.url, proxy: this.identity?.name }, 'proxy agent started');
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
  }

  stats() {
    return { ...this.buffer.stats(), failures: this.failures, proxy: this.identity?.name };
  }
}
