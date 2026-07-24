/**
 * Counter → rate conversion for SNMP-style monotonically increasing counters.
 * The previous sample lives in Redis so rates survive poller restarts and
 * work across a horizontally scaled poller fleet.
 */
import { REDIS_KEYS } from '@watcher/shared';

const COUNTER32_MAX = 2 ** 32;
const COUNTER64_MAX = 2 ** 64;

export class RateCalculator {
  constructor(redis) {
    this.redis = redis;
  }

  /**
   * @returns {Promise<number|null>} per-second rate, or null on the first
   * sample / after an implausible jump (device reboot, counter reset).
   */
  async rate(deviceId, metric, instance, rawValue, { is64 = true, nowMs = Date.now() } = {}) {
    const key = REDIS_KEYS.pollerSample(deviceId, metric, instance);
    const prev = await this.redis.hgetall(key);
    await this.redis.hset(key, { v: String(rawValue), t: String(nowMs) });
    await this.redis.expire(key, 3600);

    if (!prev.v) return null;
    const prevValue = Number(prev.v);
    const elapsedS = (nowMs - Number(prev.t)) / 1000;
    if (elapsedS <= 0) return null;

    let delta = rawValue - prevValue;
    if (delta < 0) {
      // Counter wrapped — recover the true delta once, treat bigger jumps
      // (reboot / reset) as invalid.
      const max = is64 ? COUNTER64_MAX : COUNTER32_MAX;
      delta += max;
      if (delta < 0 || delta > max / 2) return null;
    }
    return delta / elapsedS;
  }
}
