/**
 * Syslog receiver — UDP and TCP, RFC 3164 and RFC 5424.
 *
 * The grammar lives in @watcher/shared/syslog; this owns the sockets and the
 * two things sockets make you think about:
 *
 *  · framing — UDP gives you one message per datagram and TCP gives you a
 *    byte stream. RFC 6587 defines two ways to find message boundaries in
 *    that stream (octet counting, and newline delimiting) and real devices
 *    ship both, so both are read.
 *  · back-pressure — a receiver that awaits the database on every datagram
 *    stalls the event loop under load and starts dropping at the socket,
 *    where the loss is invisible. Messages are queued with a bounded depth
 *    and drained by a worker, so an overload is visible and counted.
 */
import dgram from 'node:dgram';
import net from 'node:net';
import { parseSyslog, EVENT_SOURCE, SYSLOG_FACILITY, SYSLOG_SEVERITY } from '@watcher/shared';

/** Anything longer than this from one sender is not a syslog message. */
const MAX_MESSAGE_BYTES = 64 * 1024;
/** Bounded queue: past this, we shed load knowingly rather than swap. */
const MAX_QUEUE = 20_000;

/**
 * Split a TCP buffer into complete messages, RFC 6587 both ways.
 * Returns the messages found and whatever tail is not yet a message.
 *
 * Exported for the tests: framing is where stream receivers actually break,
 * usually on the boundary between two TCP segments.
 */
export function frameTcp(buffer) {
  const messages = [];
  let rest = buffer;

  for (;;) {
    if (rest.length === 0) break;

    // Octet counting: "<len> <message>" where len counts the message bytes.
    const space = rest.indexOf(0x20);
    if (space > 0 && space <= 10) {
      const head = rest.subarray(0, space).toString('ascii');
      if (/^\d+$/.test(head)) {
        const len = Number(head);
        if (len > MAX_MESSAGE_BYTES) { rest = rest.subarray(space + 1); continue; }
        if (rest.length < space + 1 + len) break;        // wait for the rest
        messages.push(rest.subarray(space + 1, space + 1 + len));
        rest = rest.subarray(space + 1 + len);
        continue;
      }
    }

    // Newline delimited.
    const nl = rest.indexOf(0x0a);
    if (nl === -1) {
      // No terminator yet. Guard against a sender that never sends one.
      if (rest.length > MAX_MESSAGE_BYTES) { messages.push(rest.subarray(0, MAX_MESSAGE_BYTES)); rest = rest.subarray(MAX_MESSAGE_BYTES); continue; }
      break;
    }
    const line = rest.subarray(0, nl);
    if (line.length) messages.push(line);
    rest = rest.subarray(nl + 1);
  }
  return { messages, rest };
}

export class SyslogReceiver {
  /**
   * @param {object} opts
   * @param {number} [opts.port=514]
   * @param {string} [opts.host='0.0.0.0']
   * @param {boolean} [opts.udp=true]
   * @param {boolean} [opts.tcp=true]
   * @param {object} deps  {pipeline, log}
   */
  constructor(opts, { pipeline, log }) {
    this.port = Number(opts.port ?? 514);
    this.host = opts.host ?? '0.0.0.0';
    this.wantUdp = opts.udp !== false;
    this.wantTcp = opts.tcp !== false;
    this.pipeline = pipeline;
    this.log = log;
    this.queue = [];
    this.draining = false;
    this.shed = 0;
    this.udp = null;
    this.tcp = null;
  }

  async start() {
    if (this.wantUdp) await this.#startUdp();
    if (this.wantTcp) await this.#startTcp();
    this.log.info({ port: this.port, udp: this.wantUdp, tcp: this.wantTcp },
      'syslog receiver listening');
  }

  async stop() {
    await new Promise((resolve) => (this.udp ? this.udp.close(resolve) : resolve()));
    await new Promise((resolve) => (this.tcp ? this.tcp.close(resolve) : resolve()));
    this.udp = null;
    this.tcp = null;
  }

  #startUdp() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('message', (buf, rinfo) => this.#accept(buf, rinfo.address));
      sock.on('error', (err) => {
        this.log.error({ err }, 'syslog UDP socket error');
        reject(err);
      });
      sock.bind(this.port, this.host, () => {
        // A receiver on 514 needs privilege it should not keep; the systemd
        // unit grants CAP_NET_BIND_SERVICE instead of running as root.
        try { sock.setRecvBufferSize(4 * 1024 * 1024); } catch { /* best effort */ }
        this.udp = sock;
        resolve();
      });
    });
  }

  #startTcp() {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        socket.setNoDelay(true);
        const address = socket.remoteAddress?.replace(/^::ffff:/, '') ?? '';
        let buffer = Buffer.alloc(0);
        socket.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          const { messages, rest } = frameTcp(buffer);
          buffer = rest;
          if (buffer.length > MAX_MESSAGE_BYTES * 2) {
            this.log.warn({ address }, 'syslog TCP peer sent an unframed flood — closing');
            socket.destroy();
            return;
          }
          for (const m of messages) this.#accept(m, address);
        });
        socket.on('error', () => socket.destroy());
        socket.setTimeout(10 * 60_000, () => socket.destroy());
      });
      server.on('error', (err) => {
        this.log.error({ err }, 'syslog TCP server error');
        reject(err);
      });
      server.listen(this.port, this.host, () => { this.tcp = server; resolve(); });
    });
  }

  #accept(buf, address) {
    if (buf.length > MAX_MESSAGE_BYTES) buf = buf.subarray(0, MAX_MESSAGE_BYTES);
    if (this.queue.length >= MAX_QUEUE) {
      // Shedding is a decision, so it is counted and said out loud once in
      // a while rather than happening quietly inside the kernel.
      if (this.shed++ % 1000 === 0) {
        this.log.warn({ shed: this.shed, depth: this.queue.length },
          'syslog queue full — shedding messages');
      }
      return;
    }
    this.queue.push({ buf, address, at: new Date() });
    if (!this.draining) this.#drain();
  }

  async #drain() {
    this.draining = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift();
        const parsed = parseSyslog(item.buf, { now: item.at });
        await this.pipeline.handle({
          source: EVENT_SOURCE.SYSLOG,
          sourceIp: item.address,
          timestamp: parsed.timestamp,
          oid: '',
          facility: parsed.facility,
          severity: parsed.severity,
          facilityName: parsed.facilityName || SYSLOG_FACILITY[parsed.facility] || '',
          severityName: parsed.severityName || SYSLOG_SEVERITY[parsed.severity] || '',
          appName: parsed.appName,
          message: parsed.message,
          detail: parsed.structuredData
            ? { structuredData: parsed.structuredData, format: parsed.format,
                hostname: parsed.hostname, procId: parsed.procId }
            : { format: parsed.format, hostname: parsed.hostname, procId: parsed.procId },
        });
      }
    } finally {
      this.draining = false;
    }
  }

  stats() {
    return { queued: this.queue.length, shed: this.shed };
  }
}
