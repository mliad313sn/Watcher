/**
 * Configuration capture: fetch a device's running config, keep it if it
 * changed, and say so.
 *
 * The transport is the system `ssh` binary rather than a bundled SSH
 * library. Three reasons, in order of how much they matter:
 *
 *  · Network equipment is where SSH implementations go to be strange —
 *    ten-year-old key exchanges, ciphers no modern library ships, hosts that
 *    need `-oKexAlgorithms=+diffie-hellman-group1-sha1` to talk at all.
 *    OpenSSH can be told to accept them; a JS library usually cannot.
 *  · An operator already knows how to make `ssh` work with their estate, and
 *    whatever they put in `~/.ssh/config` applies here unchanged — jump
 *    hosts included, which is often the only way a management network is
 *    reachable.
 *  · It keeps the product's dependency surface where it is. An SSH library
 *    is a large amount of security-critical code to take on for one feature.
 *
 * The cost is stated rather than hidden: this needs `ssh` on the host, and
 * key-based authentication (a password would have to be handed to a child
 * process, which is worse than requiring a key).
 */
import { spawn } from 'node:child_process';
import {
  VENDOR_PROFILES, normaliseConfig, configHash, diffConfigs, changeSummary,
  REDIS_KEYS,
} from '@watcher/shared';

/** A device that has not answered in this long is not going to. */
const DEFAULT_TIMEOUT_MS = 60_000;
/** Anything past this is not a configuration; it is a device in a loop. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Run one command over SSH and return stdout.
 *
 * `-o BatchMode=yes` is the load-bearing option: it makes OpenSSH fail
 * rather than block on a password or a host-key prompt. Without it a capture
 * against an unknown host hangs until the timeout, every night, silently.
 */
export function sshCapture(host, command, options = {}) {
  const {
    user = 'watcher',
    port = 22,
    identity = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    extraArgs = [],
    spawnImpl = spawn,
  } = options;

  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${Math.max(5, Math.floor(timeoutMs / 1000 / 4))}`,
    '-p', String(port),
    ...(identity ? ['-i', identity] : []),
    ...extraArgs,
    `${user}@${host}`,
    command,
  ];

  return new Promise((resolve, reject) => {
    const child = spawnImpl('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let size = 0;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`capture of ${host} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(reject, new Error(`capture of ${host} exceeded ${MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      out += chunk;
    });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (e) => finish(reject, new Error(`ssh could not be run: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) return finish(resolve, out);
      // OpenSSH's stderr is the useful part; without it every failure reads
      // as "exit 255" and nobody can tell auth from routing.
      finish(reject, new Error(
        `ssh to ${host} exited ${code}: ${err.trim().split('\n').slice(-3).join(' ') || 'no output'}`));
    });
  });
}

export class ConfigBackup {
  /**
   * @param {object} deps {pg, redis, log, capture}
   * @param {object} [opts] {fingerprintKey, concurrency, timeoutMs}
   */
  constructor({ pg, redis, log, capture = sshCapture }, opts = {}) {
    this.pg = pg;
    this.redis = redis;
    this.log = log;
    this.capture = capture;
    this.fingerprintKey = opts.fingerprintKey ?? '';
    this.concurrency = Number(opts.concurrency ?? 4);
    this.timeoutMs = Number(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.timer = null;
  }

  start(intervalMs = 24 * 3_600_000) {
    // First sweep shortly after boot so a fresh install has a baseline the
    // same day, then on the interval.
    setTimeout(() => this.sweep().catch((err) => this.log.error({ err }, 'config sweep failed')),
      120_000).unref();
    this.timer = setInterval(
      () => this.sweep().catch((err) => this.log.error({ err }, 'config sweep failed')),
      intervalMs);
    this.timer.unref();
    this.log.info({ everyMs: intervalMs }, 'configuration backup scheduled');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Capture every enabled target, a few at a time. */
  async sweep() {
    const { rows: targets } = await this.pg.query(
      `SELECT t.device_id, t.tenant_id, t.vendor, t.credential_id, t.command,
              t.volatile_extra, d.name, host(d.address) AS address
         FROM config_targets t
         JOIN devices d ON d.id = t.device_id
        WHERE t.enabled AND d.monitored`);

    let changed = 0;
    let failed = 0;
    for (let i = 0; i < targets.length; i += this.concurrency) {
      const slice = targets.slice(i, i + this.concurrency);
      const results = await Promise.allSettled(slice.map((t) => this.captureOne(t)));
      for (const r of results) {
        if (r.status === 'rejected') { failed++; continue; }
        if (r.value?.status === 'ok') changed++;
        if (r.value?.status === 'failed') failed++;
      }
    }
    this.log.info({ targets: targets.length, changed, failed }, 'configuration sweep complete');
    return { targets: targets.length, changed, failed };
  }

  /** Capture one device, store a version only if the content changed. */
  async captureOne(target) {
    const startedAt = Date.now();
    const profile = VENDOR_PROFILES[target.vendor] ?? VENDOR_PROFILES.generic;
    const command = target.command || profile.command;

    let raw;
    try {
      raw = await this.capture(target.address, command, {
        timeoutMs: this.timeoutMs,
        user: process.env.CONFIG_SSH_USER ?? 'watcher',
        identity: process.env.CONFIG_SSH_KEY ?? null,
      });
    } catch (err) {
      await this.#record(target, 'failed', null, err.message, Date.now() - startedAt);
      // A device whose capture has been failing for a week is the one whose
      // configuration you will most want and least have, so it alerts.
      await this.#publish(target, 2, `Configuration capture failed: ${err.message}`);
      return { status: 'failed', error: err.message };
    }

    const normalised = normaliseConfig(
      raw, target.vendor,
      Array.isArray(target.volatile_extra) ? target.volatile_extra : [],
      this.fingerprintKey);

    // An empty capture that "succeeded" is the most dangerous outcome: it
    // would store an empty version, overwrite a good history, and read as a
    // device whose entire configuration was deleted.
    if (normalised.trim().length < 32) {
      const why = 'capture returned almost nothing — refusing to store it as a version';
      await this.#record(target, 'failed', null, why, Date.now() - startedAt);
      await this.#publish(target, 2, `Configuration capture failed: ${why}`);
      return { status: 'failed', error: why };
    }

    const hash = configHash(normalised);
    const { rows: existing } = await this.pg.query(
      `SELECT id, content, content_hash FROM device_configs
        WHERE device_id = $1 ORDER BY captured_at DESC LIMIT 1`,
      [target.device_id]);
    const previous = existing[0] ?? null;

    if (previous && previous.content_hash === hash) {
      await this.#record(target, 'unchanged', previous.id, '', Date.now() - startedAt);
      await this.#publish(target, 0, 'Configuration captured, unchanged.');
      return { status: 'unchanged', configId: previous.id };
    }

    const diff = previous ? diffConfigs(previous.content, normalised) : null;
    const { rows } = await this.pg.query(
      `INSERT INTO device_configs
         (tenant_id, device_id, content_hash, content, vendor, raw_bytes,
          lines_added, lines_removed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (device_id, content_hash) DO UPDATE SET captured_at = now()
       RETURNING id`,
      [target.tenant_id, target.device_id, hash, normalised, target.vendor,
        Buffer.byteLength(raw), diff?.added ?? 0, diff?.removed ?? 0]);
    const configId = rows[0].id;

    await this.#record(target, 'ok', configId, '', Date.now() - startedAt);

    // A first capture is not a change — there is nothing it changed from,
    // and announcing every device as "changed" on the first night is how the
    // feature gets muted before it has ever been useful.
    if (previous) {
      await this.#driftCheck(target, hash, changeSummary(diff));
    } else {
      await this.#publish(target, 0, 'First configuration captured.');
    }
    return { status: 'ok', configId, summary: changeSummary(diff) };
  }

  /**
   * Raise when a device no longer matches what somebody approved.
   * A device with no approved baseline is not drifting — nobody has said
   * what it should be — so it is recorded and not alerted.
   */
  async #driftCheck(target, hash, summary) {
    const { rows } = await this.pg.query(
      `SELECT content_hash FROM config_baselines WHERE device_id = $1`, [target.device_id]);
    const baseline = rows[0]?.content_hash ?? null;

    if (!baseline) {
      await this.#publish(target, 0, `Configuration changed (${summary}); no approved baseline.`);
      return;
    }
    if (baseline === hash) {
      await this.#publish(target, 0, `Configuration changed (${summary}) and matches the baseline.`);
      return;
    }
    await this.#publish(target, 1,
      `Configuration differs from the approved baseline (${summary}).`);
  }

  async #record(target, status, configId, error, durationMs) {
    await this.pg.query(
      `INSERT INTO config_captures (tenant_id, device_id, status, config_id, error, duration_ms)
       VALUES ($1,$2,$3::config_capture_status,$4,$5,$6)`,
      [target.tenant_id, target.device_id, status, configId, String(error).slice(0, 500), durationMs]);
  }

  /**
   * Onto the same state bus as everything else, so a configuration alert
   * goes through correlation, maintenance windows, on-call and runbooks
   * exactly like a failed ping.
   */
  async #publish(target, state, output) {
    await this.redis.publish(REDIS_KEYS.eventsState, JSON.stringify({
      host: target.name,
      service: 'configuration',
      kind: 'service',
      state,
      hard: true,
      output,
      tenantId: target.tenant_id,
      prevState: null,
      ts: Date.now(),
      origin: 'config-backup',
    })).catch(() => {});
  }
}
