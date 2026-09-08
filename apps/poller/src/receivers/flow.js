/**
 * Flow collector — NetFlow v5/v9, IPFIX and sFlow on one UDP port.
 *
 * The whole problem here is cardinality (RSK-48 on the delivery register:
 * "flow record cardinality is the hardest scale problem in the product").
 * A busy edge router exports tens of thousands of conversations a minute.
 * Writing one row per conversation is not a slow query later, it is a write
 * path that falls over on the first real link — which is why flow collectors
 * that store raw records need a dedicated appliance, and why this one does
 * not store raw records at all.
 *
 * So records are folded **at ingest**, in memory, into a bounded map keyed by
 * conversation, and one row per key is flushed on an interval. The reduction
 * on real traffic is one to two orders of magnitude, and what survives is
 * exactly what anyone asks flow data: who talked to whom, over what, through
 * which interface, and how much.
 *
 * The bound on the map is not an optimisation, it is the backstop: a scan or
 * a DDoS creates unique conversations as fast as the wire allows, and an
 * unbounded aggregator turns that into the collector's own out-of-memory.
 * Over the ceiling the smallest talkers are folded into one `(other)` row so
 * the totals stay true even when the detail cannot.
 */
import dgram from 'node:dgram';
import { decodeFlowPacket, aggregationKey, serviceName } from '@watcher/shared';

/** Templates older than this are stale: exporters refresh every few minutes. */
const TEMPLATE_TTL_MS = 30 * 60_000;

export class FlowAggregator {
  /**
   * @param {object} opts
   * @param {number} [opts.maxKeys=20000] conversations held between flushes
   */
  constructor({ maxKeys = 20_000 } = {}) {
    this.maxKeys = maxKeys;
    this.buckets = new Map();
    this.overflowBytes = 0;
    this.overflowPackets = 0;
    this.overflowFlows = 0;
  }

  add(record, exporter, deviceId, tenantId) {
    // A flow with no addresses is a record we could not read; counting it
    // would make the totals lie.
    if (!record.srcAddr || !record.dstAddr) return;

    const key = `${exporter}|${aggregationKey(record)}`;
    const existing = this.buckets.get(key);
    if (existing) {
      existing.bytes += record.bytes;
      existing.packets += record.packets;
      existing.flows += 1;
      return;
    }
    if (this.buckets.size >= this.maxKeys) {
      this.overflowBytes += record.bytes;
      this.overflowPackets += record.packets;
      this.overflowFlows += 1;
      return;
    }
    const [a, b] = record.srcAddr <= record.dstAddr
      ? [record.srcAddr, record.dstAddr]
      : [record.dstAddr, record.srcAddr];
    this.buckets.set(key, {
      tenantId, deviceId, exporter,
      srcAddr: a, dstAddr: b,
      protocol: record.protocol,
      service: serviceName(record.protocol, record.srcPort, record.dstPort),
      ifIndex: record.inputIf,
      bytes: record.bytes, packets: record.packets, flows: 1,
      sampled: !!record.sampled,
    });
  }

  /** Take everything accumulated and reset. */
  drain(tenantId) {
    const rows = [...this.buckets.values()];
    if (this.overflowFlows) {
      // One honest row rather than a silently wrong total.
      rows.push({
        tenantId, deviceId: null, exporter: '',
        srcAddr: '0.0.0.0', dstAddr: '0.0.0.0', protocol: 0,
        service: '(other)', ifIndex: 0,
        bytes: this.overflowBytes, packets: this.overflowPackets,
        flows: this.overflowFlows, sampled: false,
      });
    }
    this.buckets = new Map();
    this.overflowBytes = 0;
    this.overflowPackets = 0;
    this.overflowFlows = 0;
    return rows;
  }

  get size() { return this.buckets.size; }
}

export class FlowReceiver {
  /**
   * @param {object} opts  {port, flushMs, maxKeys}
   * @param {object} deps  {pg, tsdb, log}
   */
  constructor(opts, { pg, tsdb, log }) {
    this.port = Number(opts.port ?? 2055);
    this.host = opts.host ?? '0.0.0.0';
    this.flushMs = Number(opts.flushMs ?? 60_000);
    this.pg = pg;
    this.tsdb = tsdb;
    this.log = log;
    this.aggregator = new FlowAggregator({ maxKeys: opts.maxKeys });
    this.templates = new Map();
    this.exporters = { at: 0, byAddress: new Map() };
    this.tenantId = null;
    this.socket = null;
    this.timer = null;
    this.stats = { datagrams: 0, records: 0, pendingTemplates: 0, unreadable: 0, rowsWritten: 0 };
  }

  async start() {
    await new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('message', (buf, rinfo) => this.#onDatagram(buf, rinfo.address));
      sock.on('error', (err) => { this.log.error({ err }, 'flow socket error'); reject(err); });
      sock.bind(this.port, this.host, () => {
        try { sock.setRecvBufferSize(8 * 1024 * 1024); } catch { /* best effort */ }
        this.socket = sock;
        resolve();
      });
    });

    this.timer = setInterval(
      () => this.flush().catch((err) => this.log.error({ err }, 'flow flush failed')),
      this.flushMs);
    this.timer.unref();
    this.log.info({ port: this.port, flushMs: this.flushMs }, 'flow collector listening');
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush().catch(() => {});
    await new Promise((resolve) => (this.socket ? this.socket.close(resolve) : resolve()));
    this.socket = null;
  }

  #onDatagram(buf, address) {
    this.stats.datagrams++;
    const decoded = decodeFlowPacket(buf, this.templates, address);
    if (!decoded) { this.stats.unreadable++; return; }

    this.stats.pendingTemplates += decoded.pending ?? 0;
    const exporter = this.exporters.byAddress.get(address);
    // Flow from an exporter we cannot name is still counted — unlike an
    // event it cannot page anyone, so there is nothing to inject.
    for (const record of decoded.records) {
      this.aggregator.add(record, address, exporter?.deviceId ?? null,
        exporter?.tenantId ?? this.tenantId);
    }
    this.stats.records += decoded.records.length;
  }

  /** Refresh exporter identity and evict templates that have gone stale. */
  async #refreshExporters() {
    const now = Date.now();
    if (now - this.exporters.at < 60_000) return;
    const { rows: tenants } = await this.pg.query('SELECT id FROM tenants ORDER BY created_at LIMIT 1');
    this.tenantId = tenants[0]?.id ?? null;
    const { rows } = await this.pg.query(
      `SELECT id, tenant_id, name, host(address) AS address FROM devices WHERE address IS NOT NULL`);
    const map = new Map();
    for (const d of rows) {
      map.set(d.address, { deviceId: d.id, tenantId: d.tenant_id, deviceName: d.name });
    }
    this.exporters = { at: now, byAddress: map };

    for (const [key, template] of this.templates) {
      if (now - template.at > TEMPLATE_TTL_MS) this.templates.delete(key);
    }
  }

  /** Write one interval's worth of folded conversations. */
  async flush(at = new Date()) {
    await this.#refreshExporters().catch(() => {});
    const rows = this.aggregator.drain(this.tenantId);
    if (!rows.length) return 0;

    // One multi-row insert: a flush is the only write this collector makes,
    // so it must not be a per-row round trip.
    const params = [];
    const tuples = rows.map((r, i) => {
      const o = i * 11;
      params.push(at, r.tenantId, r.deviceId, r.exporter || null, r.srcAddr, r.dstAddr,
        r.protocol, r.service, r.ifIndex, r.bytes, r.packets);
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},`
        + `$${o + 7},$${o + 8},$${o + 9},$${o + 10},$${o + 11})`;
    }).join(',');

    await this.tsdb.query(
      `INSERT INTO flows
         (time, tenant_id, device_id, exporter, src_addr, dst_addr,
          protocol, service, if_index, bytes, packets)
       VALUES ${tuples}`,
      params);

    this.stats.rowsWritten += rows.length;
    this.log.debug({ rows: rows.length }, 'flow interval written');
    return rows.length;
  }

  statsSnapshot() {
    return { ...this.stats, buffered: this.aggregator.size, templates: this.templates.size };
  }
}
