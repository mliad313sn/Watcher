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
  constructor({ pg, log, connectors, getCredential, concurrency = 32 }) {
    this.pg = pg;
    this.log = log;
    this.connectors = connectors;
    this.getCredential = getCredential;
    this.concurrency = concurrency;
    this.active = 0;
    this.jobs = new Map();     // assignment id → {timer, assignment}
    this.reloadTimer = null;
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
    const { rows } = await this.pg.query(
      `SELECT pa.id, pa.protocol, pa.interval_s, pa.credential_id, pa.config,
              d.id AS device_id, d.name, host(d.address) AS address
       FROM poll_assignments pa
       JOIN devices d ON d.id = pa.device_id
       WHERE pa.enabled AND d.monitored`);

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
    this.log.info({ assignments: rows.length }, 'poll assignments loaded');
  }

  async #run(job) {
    if (this.active >= this.concurrency) return; // shed load; next cycle catches up
    const a = job.assignment;
    const connector = this.connectors.get(a.protocol);
    if (!connector) return;

    this.active++;
    const startedAt = Date.now();
    try {
      const cred = a.credential_id ? await this.getCredential(a.credential_id) : {};
      await connector.poll(
        { id: a.device_id, name: a.name, address: a.address },
        cred,
        a.config ?? {},
      );
      this.log.debug({ device: a.name, protocol: a.protocol, ms: Date.now() - startedAt }, 'poll ok');
    } catch (err) {
      this.log.warn({ device: a.name, protocol: a.protocol, err: err.message }, 'poll failed');
    } finally {
      this.active--;
    }
  }
}
