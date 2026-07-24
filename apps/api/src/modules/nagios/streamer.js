/**
 * Nagios → Redis streamer.
 *
 * Watches status.dat (mtime-gated so unchanged files cost one stat() call),
 * parses it, diffs every host/service against the Redis state cache and:
 *
 *   1. updates the current-state hashes (watcher:state:host:* / :svc:*),
 *   2. publishes state *changes* to the watcher:events:state channel,
 *   3. records hard transitions into the state_changes hypertable
 *      (availability/SLA reporting).
 *
 * Only deltas leave this module — a 10k-service installation at steady state
 * publishes nothing.
 */
import { stat, readFile } from 'node:fs/promises';
import { REDIS_KEYS, stateName } from '@watcher/shared';
import { parseStatusDat, normalizeObject } from './status-parser.js';

export class NagiosStreamer {
  /**
   * @param {object} deps
   * @param {import('ioredis').Redis} deps.redis
   * @param {import('pg').Pool} deps.tsdb   TimescaleDB pool (state_changes)
   * @param {object} deps.log               pino-compatible logger
   * @param {object} opts                   config.nagios
   */
  constructor({ redis, tsdb, log }, opts) {
    this.redis = redis;
    this.tsdb = tsdb;
    this.log = log;
    this.opts = opts;
    this.lastMtimeMs = 0;
    this.timer = null;
    this.running = false;
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

  async tick() {
    if (this.running) return; // don't overlap slow ticks
    this.running = true;
    try {
      let fileStat;
      try {
        fileStat = await stat(this.opts.statusFile);
      } catch {
        return; // Nagios not up yet — keep polling quietly
      }
      if (fileStat.mtimeMs === this.lastMtimeMs) return;
      this.lastMtimeMs = fileStat.mtimeMs;

      const text = await readFile(this.opts.statusFile, 'utf8');
      const { hosts, services } = parseStatusDat(text);

      for (const block of hosts) await this.#processObject(normalizeObject(block, true));
      for (const block of services) await this.#processObject(normalizeObject(block, false));
    } finally {
      this.running = false;
    }
  }

  async #processObject(obj) {
    const key = obj.kind === 'host'
      ? REDIS_KEYS.hostState(obj.host)
      : REDIS_KEYS.serviceState(obj.host, obj.service);

    const prev = await this.redis.hgetall(key);
    const prevState = prev.state === undefined ? null : Number(prev.state);
    const prevHard = prev.hard === '1';

    // Persist current state (flat hash — cheap to read for grids/summaries).
    await this.redis
      .multi()
      .hset(key, {
        kind: obj.kind,
        host: obj.host,
        service: obj.service,
        state: obj.state,
        hard: obj.hard ? 1 : 0,
        output: obj.output,
        perfData: obj.perfData,
        lastCheck: obj.lastCheck,
        lastStateChange: obj.lastStateChange,
        flapping: obj.flapping ? 1 : 0,
        acknowledged: obj.acknowledged ? 1 : 0,
        inDowntime: obj.inDowntime ? 1 : 0,
      })
      .sadd(REDIS_KEYS.stateIndex, key)
      .exec();

    const changed = prevState !== obj.state || prevHard !== obj.hard;
    if (!changed) return;

    const event = {
      ...obj,
      prevState,
      stateName: stateName(obj.kind === 'host', obj.state),
      ts: Date.now(),
    };
    await this.redis.publish(REDIS_KEYS.eventsState, JSON.stringify(event));

    // Durable history: hard transitions only (soft states are retry noise).
    if (obj.hard && prevState !== null) {
      await this.tsdb.query(
        `INSERT INTO state_changes (time, device_name, check_name, hard, from_state, to_state, output)
         VALUES (now(), $1, $2, true, $3, $4, $5)`,
        [obj.host, obj.service, prevState, obj.state, obj.output],
      ).catch((err) => this.log.warn({ err }, 'state_changes insert failed'));
    }
  }
}
