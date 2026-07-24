/**
 * Counter → rate conversion for SNMP-style monotonically increasing counters.
 * The previous sample lives in Redis so rates survive poller restarts and
 * work across a horizontally scaled poller fleet.
 *
 * All counter arithmetic is done in BigInt: SNMP Counter64 values (and the
 * 2^64 wrap point) exceed JS Number's 2^53 exact-integer range, so doing the
 * delta/wrap math in Number silently corrupts rates on high-capacity (e.g.
 * 100G) interface octet counters (issue M1).
 */
import { REDIS_KEYS } from '@watcher/shared';

const COUNTER32_MAX = 1n << 32n;
const COUNTER64_MAX = 1n << 64n;

function toBig(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  return BigInt(value); // decimal string
}

export class RateCalculator {
  constructor(redis) {
    this.redis = redis;
  }

  /**
   * @param {bigint|number|string} rawValue current counter reading
   * @returns {Promise<number|null>} per-second rate, or null on the first
   * sample / after an implausible jump (device reboot, counter reset).
   */
  async rate(deviceId, metric, instance, rawValue, { is64 = true, nowMs = Date.now() } = {}) {
    const key = REDIS_KEYS.pollerSample(deviceId, metric, instance);
    const cur = toBig(rawValue);
    const prev = await this.redis.hgetall(key);
    await this.redis.hset(key, { v: cur.toString(), t: String(nowMs) });
    await this.redis.expire(key, 3600);

    if (!prev.v) return null;
    const prevValue = toBig(prev.v);
    const elapsedS = (nowMs - Number(prev.t)) / 1000;
    if (elapsedS <= 0) return null;

    let delta = cur - prevValue;
    if (delta < 0n) {
      // Counter wrapped — recover the true delta once, treat bigger jumps
      // (reboot / reset) as invalid.
      const max = is64 ? COUNTER64_MAX : COUNTER32_MAX;
      delta += max;
      if (delta < 0n || delta > max / 2n) return null;
    }
    return Number(delta) / elapsedS;
  }
}
