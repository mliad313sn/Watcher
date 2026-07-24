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
  constructor({ tsdb, redis, log }, { batchSize = 500, flushMs = 2000, maxBuffer = 50_000 } = {}) {
    this.tsdb = tsdb;
    this.redis = redis;
    this.log = log;
    this.batchSize = batchSize;
    // Hard cap so a prolonged DB outage can't exhaust memory. When exceeded we
    // drop the OLDEST samples and count them — visible loss, not silent.
    this.maxBuffer = maxBuffer;
    this.dropped = 0;
    this.buffer = [];
    this.flushing = false;
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
    if (this.flushing || this.buffer.length === 0) return; // no overlap / re-entrancy
    this.flushing = true;
    // Take a snapshot WITHOUT emptying the buffer — rows stay queued until the
    // insert actually succeeds, so a DB error re-queues instead of losing data.
    const rows = this.buffer.slice(0, this.batchSize);

    try {
      const params = [];
      const tuples = rows.map((r, i) => {
        const o = i * 6;
        params.push(r.time, r.deviceId, r.metric, r.instance, r.value,
          r.tags ? JSON.stringify(r.tags) : null);
        return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`;
      });

      await this.tsdb.query(
        `INSERT INTO metrics (time, device_id, metric, instance, value, tags)
         VALUES ${tuples.join(', ')}
         ON CONFLICT DO NOTHING`,
        params,
      );

      // Success — now remove exactly the rows we wrote.
      this.buffer.splice(0, rows.length);

      // Fire-and-forget live tick for dashboards subscribed to 'metrics'.
      this.redis.publish(REDIS_KEYS.eventsMetrics, JSON.stringify(
        rows.map((r) => ({ d: r.deviceId, m: r.metric, i: r.instance, v: r.value, t: r.time })),
      )).catch(() => {});
    } catch (err) {
      // Keep the rows queued for the next flush; shed oldest only if we're
      // about to run out of memory, and count what we drop.
      this.log.warn({ err, buffered: this.buffer.length }, 'metric flush failed — rows re-queued');
      if (this.buffer.length > this.maxBuffer) {
        const overflow = this.buffer.length - this.maxBuffer;
        this.buffer.splice(0, overflow);
        this.dropped += overflow;
        this.log.error({ dropped: this.dropped }, 'metric buffer overflow — oldest samples dropped');
      }
    } finally {
      this.flushing = false;
    }
  }

  async close() {
    clearInterval(this.timer);
    // Drain whatever is buffered, batch by batch.
    while (this.buffer.length > 0) {
      const before = this.buffer.length;
      await this.flush();
      if (this.buffer.length >= before) break; // DB unreachable — stop looping
    }
  }
}
