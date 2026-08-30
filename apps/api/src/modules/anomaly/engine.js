/**
 * Dynamic-threshold engine.
 *
 * Every sweep, for each (device, metric) pair active in the last window:
 *   1. baseline = robust median+MAD over the trailing history (excluding the
 *      current window, so an ongoing incident can't normalise itself),
 *   2. compare the window's average against the baseline,
 *   3. open an explainable `anomaly:<metric>` warning alert when it deviates,
 *      and resolve it once the metric returns to normal.
 *
 * Static thresholds still rule for hard limits (disk 90%); this catches the
 * "CPU is 4× its normal Tuesday level" class nobody writes thresholds for.
 */
import { REDIS_KEYS } from '@watcher/shared';
import { robustBaseline, judge } from './baseline.js';

export class AnomalyEngine {
  constructor({ pg, tsdb, redis, log }, opts = {}) {
    this.pg = pg;
    this.tsdb = tsdb;
    this.redis = redis;
    this.log = log;
    this.sweepMs = opts.sweepMs ?? 300_000;      // 5 min
    this.windowMin = opts.windowMin ?? 10;       // "now" = last 10 min avg
    this.historyDays = opts.historyDays ?? 7;    // baseline depth
    this.zThreshold = opts.zThreshold ?? 4;
    this.minDeltaPct = opts.minDeltaPct ?? 10;
    this.minSamples = opts.minSamples ?? 24;
  }

  start() {
    this.timer = setInterval(() => {
      this.sweep().catch((err) => this.log.error({ err }, 'anomaly sweep failed'));
    }, this.sweepMs);
    this.timer.unref();
    this.log.info({ sweepMs: this.sweepMs, z: this.zThreshold }, 'anomaly engine started');
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  async sweep() {
    // Current level per active (device, metric): average over the last window.
    const { rows: current } = await this.tsdb.query(
      `SELECT device_id, metric, avg(value) AS value, count(*) AS n
       FROM metrics
       WHERE time >= now() - make_interval(mins => $1) AND instance = ''
       GROUP BY device_id, metric`,
      [this.windowMin]);
    if (current.length === 0) return { checked: 0, anomalies: 0 };

    let anomalies = 0;
    for (const cur of current) {
      // Trailing history, excluding the judgment window.
      const { rows: hist } = await this.tsdb.query(
        `SELECT avg_value AS value FROM metrics_5m
         WHERE device_id = $1 AND metric = $2 AND instance = ''
           AND bucket >= now() - make_interval(days => $3)
           AND bucket < now() - make_interval(mins => $4)`,
        [cur.device_id, cur.metric, this.historyDays, this.windowMin]);
      const baseline = robustBaseline(hist.map((r) => Number(r.value)), { minSamples: this.minSamples });
      const value = Number(cur.value);
      const verdict = judge(value, baseline, { zThreshold: this.zThreshold, minDeltaPct: this.minDeltaPct });

      const dev = await this.#device(cur.device_id);
      if (!dev) continue;
      const checkName = `anomaly:${cur.metric}`;

      if (verdict.anomalous) {
        anomalies += await this.#raise(dev, checkName, cur.metric, value, baseline, verdict);
      } else {
        await this.#resolveIfOpen(dev, checkName);
      }
    }
    return { checked: current.length, anomalies };
  }

  async #raise(dev, checkName, metric, value, baseline, verdict) {
    const direction = value > baseline.median ? 'above' : 'below';
    const message = `Anomaly: ${metric} = ${value.toFixed(1)} — ${verdict.z >= 0 ? '+' : ''}${verdict.z}σ ${direction} its ${this.historyDays}-day normal of ${baseline.median.toFixed(1)} (${verdict.deltaPct}% off baseline, n=${baseline.n})`;
    let rows;
    try {
      ({ rows } = await this.pg.query(
        `INSERT INTO alerts (tenant_id, device_id, device_name, check_name, severity, status, message)
         VALUES ($1, $2, $3, $4, 'warning', 'open', $5)
         RETURNING *`,
        [dev.tenant_id, dev.id, dev.name, checkName, message]));
    } catch (err) {
      // alerts_open_dedup_idx: this anomaly is already open — don't re-raise.
      if (err.code === '23505') return 0;
      throw err;
    }
    const alert = rows[0];
    this.log.warn({ device: dev.name, metric, z: verdict.z }, 'anomaly alert raised');
    await this.redis.publish(REDIS_KEYS.eventsAlerts,
      JSON.stringify({ action: 'raised', alert })).catch(() => {});
    return 1;
  }

  async #resolveIfOpen(dev, checkName) {
    const { rows } = await this.pg.query(
      `UPDATE alerts SET status = 'resolved', resolved_at = now()
       WHERE tenant_id = $1 AND device_name = $2 AND check_name = $3
         AND status IN ('open', 'acknowledged')
       RETURNING *`,
      [dev.tenant_id, dev.name, checkName]);
    for (const alert of rows) {
      await this.redis.publish(REDIS_KEYS.eventsAlerts,
        JSON.stringify({ action: 'resolved', alert })).catch(() => {});
      this.log.info({ device: dev.name, check: checkName }, 'anomaly resolved — back to baseline');
    }
  }

  async #device(id) {
    const { rows } = await this.pg.query(
      'SELECT id, name, tenant_id FROM devices WHERE id = $1', [id]);
    return rows[0] ?? null;
  }
}
