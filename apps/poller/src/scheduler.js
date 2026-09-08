/**
 * Poll scheduler.
 *
 * Loads poll_assignments from Postgres (refreshed every minute so UI changes
 * apply without restarts), and runs each (device, protocol) on its own
 * interval with a global concurrency cap. Jittered start prevents thundering
 * herds after a restart. Failures are logged and retried on the next cycle —
 * a broken device never stalls the fleet.
 */

export class Scheduler {
  /**
   * @param {object} deps
   * @param {import('pg').Pool} deps.pg
   * @param {object} deps.log
   * @param {Map<string, {poll: Function}>} deps.connectors protocol → connector
   * @param {(id: string) => Promise<object>} deps.getCredential decrypted blob by id
   * @param {number} [deps.concurrency]
   */
  constructor({ pg, log, connectors, getCredential, concurrency = 32,
                pollTimeoutMs = 30_000, assigned = false }) {
    this.pg = pg;
    this.log = log;
    this.connectors = connectors;
    this.getCredential = getCredential;
    this.concurrency = concurrency;
    this.pollTimeoutMs = pollTimeoutMs;
    this.active = 0;
    this.skipped = 0;          // polls shed because the pool was saturated
    this.jobs = new Map();     // assignment id → {timer, assignment}
    this.credCache = new Map();// credential id → decrypted blob (invalidated on reload)
    this.reloadTimer = null;
    /* Proxy mode: the assignment list arrives from the central API rather
       than from a database this host cannot reach. Set at construction so
       that start() never attempts the reload — a remote site has no
       configuration database to read one from. */
    this.assigned = assigned;
  }

  /**
   * Take the device list from the central API (proxy mode).
   *
   * A remote proxy has no database, so `reload()` has nothing to read. The
   * central console is the authority on which site owns which device, and
   * this replaces whatever was running — a device moved to another proxy
   * must stop being polled here, or two sites report on it and the alert
   * stack sees a device that flaps between two truths.
   *
   * Credentials are resolved from the proxy's OWN local configuration by the
   * name the assignment carries. No device password ever leaves the centre.
   */
  setDevices(assignments) {
    this.assigned = true;
    clearInterval(this.reloadTimer);
    this.reloadTimer = null;

    const rows = (assignments ?? []).map((a) => ({
      id: `${a.id}:${a.protocol}`,
      protocol: a.protocol,
      interval_s: a.interval_s ?? 60,
      credential_id: null,
      credential_ref: a.credential_ref ?? null,
      config: a.config ?? {},
      device_id: a.id,
      name: a.name,
      address: a.address,
    }));
    this.#applyAssignments(rows);
    this.log.info({ assignments: rows.length }, 'assignments received from the central API');
    return rows.length;
  }

  /** Decrypt + cache credentials so we don't hit the DB / KDF on every poll. */
  async #cred(id, ref) {
    // Proxy mode: the assignment names a credential, and the secret lives in
    // this host's own configuration. Nothing to fetch, nothing to decrypt.
    if (this.assigned) return this.localCredentials?.[ref] ?? {};
    if (!id) return {};
    if (this.credCache.has(id)) return this.credCache.get(id);
    const cred = await this.getCredential(id);
    this.credCache.set(id, cred);
    return cred;
  }

  async start() {
    await this.reload();
    this.reloadTimer = setInterval(() => {
      this.reload().catch((err) => this.log.error({ err }, 'assignment reload failed'));
    }, 60_000);
    this.reloadTimer.unref();
  }

  stop() {
    clearInterval(this.reloadTimer);
    for (const { timer } of this.jobs.values()) clearInterval(timer);
    this.jobs.clear();
  }

  async reload() {
    // In proxy mode the assignment list comes from the API; there is no
    // database here to read one from.
    if (this.assigned) return;
    this.credCache.clear(); // pick up credential rotations within a minute
    const { rows } = await this.pg.query(
      `SELECT pa.id, pa.protocol, pa.interval_s, pa.credential_id, pa.config,
              d.id AS device_id, d.name, host(d.address) AS address
       FROM poll_assignments pa
       JOIN devices d ON d.id = pa.device_id
       WHERE pa.enabled AND d.monitored`);

    this.#applyAssignments(rows);
    this.log.info({ assignments: rows.length }, 'poll assignments loaded');
  }

  /** Reconcile the running jobs against a desired assignment list. */
  #applyAssignments(rows) {
    const seen = new Set();
    for (const row of rows) {
      seen.add(row.id);
      const existing = this.jobs.get(row.id);
      if (existing && existing.intervalS === row.interval_s) {
        existing.assignment = row; // pick up config/credential changes in place
        continue;
      }
      if (existing) clearInterval(existing.timer);

      const jitter = Math.floor(Math.random() * row.interval_s * 1000);
      const job = { assignment: row, intervalS: row.interval_s, timer: null };
      setTimeout(() => {
        this.#run(job);
        job.timer = setInterval(() => this.#run(job), row.interval_s * 1000);
        job.timer.unref();
      }, jitter).unref();
      this.jobs.set(row.id, job);
    }

    for (const [id, job] of this.jobs) {
      if (!seen.has(id)) {
        clearInterval(job.timer);
        this.jobs.delete(id);
      }
    }
  }

  async #run(job) {
    const a = job.assignment;
    // Load shedding is a real data gap — count it and surface it (issue M2)
    // instead of dropping the poll silently.
    if (this.active >= this.concurrency) {
      this.skipped++;
      if (this.skipped % 100 === 1) {
        this.log.warn({ skipped: this.skipped, concurrency: this.concurrency },
          'poll(s) skipped — poller saturated; consider raising POLLER_CONCURRENCY or scaling out');
      }
      return;
    }
    const connector = this.connectors.get(a.protocol);
    if (!connector) return;

    this.active++;
    const startedAt = Date.now();
    try {
      const cred = await this.#cred(a.credential_id, a.credential_ref);
      // Hard timeout so a hung connector (stuck WinRM fetch, dead AMI socket)
      // can't hold a concurrency slot forever and starve the fleet (issue M2).
      await this.#withTimeout(
        connector.poll({ id: a.device_id, name: a.name, address: a.address }, cred, a.config ?? {}),
        `${a.protocol} poll of ${a.name}`,
      );
      this.log.debug({ device: a.name, protocol: a.protocol, ms: Date.now() - startedAt }, 'poll ok');
    } catch (err) {
      this.log.warn({ device: a.name, protocol: a.protocol, err: err.message }, 'poll failed');
    } finally {
      this.active--;
    }
  }

  #withTimeout(promise, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${this.pollTimeoutMs}ms: ${label}`)), this.pollTimeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}
