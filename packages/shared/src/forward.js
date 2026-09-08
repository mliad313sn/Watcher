/**
 * Store-and-forward: the buffer a remote proxy keeps when the central API is
 * unreachable, and the backoff it retries on.
 *
 * A proxy sits at the far end of exactly the link most likely to fail, so
 * "the API is unreachable" is a normal operating state, not an incident.
 * What matters is which observations survive it.
 *
 * Two rules decide that, and they pull in opposite directions:
 *
 *  · The buffer is bounded. An unbounded one turns a two-day WAN outage into
 *    a proxy that dies of memory exhaustion, losing everything including the
 *    ability to say why.
 *  · When the bound is reached, the OLDEST observations are dropped, not the
 *    newest. This is the opposite of a queue and it is deliberate: after a
 *    long outage, what an operator needs is the current state of the site,
 *    not a faithful replay of what it looked like two days ago. Monitoring
 *    data is perishable in a way that a work queue is not.
 *
 * Pure and synchronous — no timers, no sockets — so every one of these
 * behaviours is directly testable.
 */

/** Bounded, newest-wins buffer of pending batches. */
export class ForwardBuffer {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxItems=50000]  observations held across an outage
   * @param {number} [opts.batchSize=500]   observations per delivery attempt
   */
  constructor({ maxItems = 50_000, batchSize = 500 } = {}) {
    this.maxItems = maxItems;
    this.batchSize = batchSize;
    this.items = [];
    this.dropped = 0;
  }

  get size() { return this.items.length; }

  /** Queue observations, discarding the oldest if that overflows the bound. */
  push(observations) {
    const list = Array.isArray(observations) ? observations : [observations];
    if (!list.length) return 0;
    this.items.push(...list);
    const excess = this.items.length - this.maxItems;
    if (excess > 0) {
      this.items.splice(0, excess);
      this.dropped += excess;
    }
    return list.length;
  }

  /**
   * The next batch to attempt, without removing it. A batch is only dropped
   * once the far end has confirmed it — a proxy that deletes on send loses
   * exactly the data that was in flight when the link failed.
   */
  peek() {
    return this.items.slice(0, this.batchSize);
  }

  /** Confirm delivery of the batch that peek() returned. */
  commit(count) {
    this.items.splice(0, Math.min(count, this.items.length));
  }

  /** Everything, for a graceful shutdown that persists to disk. */
  drain() {
    const all = this.items;
    this.items = [];
    return all;
  }

  stats() {
    return { queued: this.items.length, dropped: this.dropped, capacity: this.maxItems };
  }
}

/**
 * Retry delay, exponential with full jitter.
 *
 * The jitter is not a nicety. When a central API restarts, every proxy in the
 * estate discovers it at the same moment and retries on the same schedule —
 * and a synchronised herd of proxies is how a recovering API is knocked back
 * over. Full jitter spreads them across the whole interval, which is the
 * variant that actually decorrelates rather than merely softening the peak.
 *
 * @param {number} attempt      how many consecutive failures, from 0
 * @param {object} [opts]
 * @param {number} [opts.baseMs=1000]
 * @param {number} [opts.maxMs=300000]  five minutes: long enough to stop
 *                                      hammering, short enough that recovery
 *                                      is not noticeably delayed
 * @param {() => number} [opts.random]  injected for the tests
 */
export function retryDelay(attempt, { baseMs = 1000, maxMs = 300_000, random = Math.random } = {}) {
  const n = Math.max(0, Math.min(attempt, 30));
  const ceiling = Math.min(maxMs, baseMs * 2 ** n);
  return Math.floor(random() * ceiling);
}

/**
 * Is a proxy overdue?
 *
 * The single most important predicate in distributed monitoring. When a
 * proxy stops reporting, its whole site stops being checked — and the
 * console shows no alerts for that site, because nothing is checking it. The
 * site looks healthy. That is the failure mode that makes a distributed
 * monitoring system worse than none at all, because it is trusted.
 *
 * A proxy that has never reported is NOT overdue: it has been created and
 * not yet enrolled, which is a different condition with a different fix, and
 * paging someone for it on the day they set it up teaches them to ignore it.
 */
export function isStale(proxy, now = Date.now()) {
  if (!proxy || proxy.status !== 'active') return false;
  if (!proxy.lastSeenAt) return false;
  const seen = new Date(proxy.lastSeenAt).getTime();
  if (!Number.isFinite(seen)) return false;
  const deadline = (proxy.staleAfterSeconds ?? 300) * 1000;
  return now - seen > deadline;
}

/**
 * How a proxy is doing, in the words a console uses.
 * `silent` is deliberately distinct from `down`: nobody knows whether the
 * site is down, only that we have stopped hearing about it.
 */
export function proxyHealth(proxy, now = Date.now()) {
  if (!proxy) return 'unknown';
  if (proxy.status === 'disabled') return 'disabled';
  if (proxy.status === 'pending' || !proxy.lastSeenAt) return 'never connected';
  if (isStale(proxy, now)) return 'silent';
  // A backlog means observations are being made but not delivered: the site
  // is being checked and the console is behind. Worth saying before it
  // becomes loss.
  if ((proxy.queueDepth ?? 0) > 0) return 'behind';
  return 'healthy';
}
