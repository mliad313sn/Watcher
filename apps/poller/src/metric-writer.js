/**
 * Batched writer into the TimescaleDB metrics hypertable.
 *
 * Connectors call push() per sample; rows are flushed either when the buffer
 * reaches `batchSize` or every `flushMs`, whichever comes first. A multi-row
 * VALUES insert keeps ingest cheap without needing COPY plumbing.
 * Live samples are also published to Redis so open charts tick in real time.
 */
import { REDIS_KEYS } from '@watcher/shared';

export class MetricWriter {
  constructor({ tsdb, redis, log }, { batchSize = 500, flushMs = 2000 } = {}) {
    this.tsdb = tsdb;
    this.redis = redis;
    this.log = log;
    this.batchSize = batchSize;
    this.buffer = [];
    this.timer = setInterval(() => {
      this.flush().catch((err) => log.error({ err }, 'metric flush failed'));
    }, flushMs);
    this.timer.unref();
  }

  /**
   * @param {{deviceId: string, metric: string, instance?: string,
   *          value: number, tags?: object, time?: Date}} sample
   */
  push(sample) {
    if (!Number.isFinite(sample.value)) return;
    this.buffer.push({
      time: sample.time ?? new Date(),
      deviceId: sample.deviceId,
      metric: sample.metric,
      instance: sample.instance ?? '',
      value: sample.value,
      tags: sample.tags ?? null,
    });
    if (this.buffer.length >= this.batchSize) {
      this.flush().catch((err) => this.log.error({ err }, 'metric flush failed'));
    }
  }

  async flush() {
    if (this.buffer.length === 0) return;
    const rows = this.buffer.splice(0, this.buffer.length);

    const params = [];
    const tuples = rows.map((r, i) => {
      const o = i * 6;
      params.push(r.time, r.deviceId, r.metric, r.instance, r.value,
        r.tags ? JSON.stringify(r.tags) : null);
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`;
    });

    await this.tsdb.query(
      `INSERT INTO metrics (time, device_id, metric, instance, value, tags)
       VALUES ${tuples.join(', ')}`,
      params,
    );

    // Fire-and-forget live tick for dashboards subscribed to 'metrics'.
    this.redis.publish(REDIS_KEYS.eventsMetrics, JSON.stringify(
      rows.map((r) => ({ d: r.deviceId, m: r.metric, i: r.instance, v: r.value, t: r.time })),
    )).catch(() => {});
  }

  async close() {
    clearInterval(this.timer);
    await this.flush();
  }
}
