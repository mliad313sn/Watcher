/**
 * Asterisk / FreePBX connector via AMI (Asterisk Manager Interface).
 *
 * Plain TCP protocol (default port 5038): login, send Actions, read
 * key:value response/event blocks separated by blank lines. Collected:
 *   - active channels & calls        (CoreShowChannels / CoreStatus)
 *   - SIP/PJSIP peer availability    (PJSIPShowEndpoints / SIPpeers)
 *   - queue depth & agent status     (QueueStatus)
 *
 * Credential blob: { host?, port?: 5038, user, password, pjsip?: boolean }
 */
import net from 'node:net';

export class AmiClient {
  constructor({ host, port = 5038, user, password }, log) {
    this.opts = { host, port, user, password };
    this.log = log;
    this.socket = null;
    this.buffer = '';
    this.pending = new Map();   // ActionID → {resolve, events: []}
    this.actionSeq = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.opts.port, this.opts.host);
      this.socket.setEncoding('utf8');
      this.socket.setTimeout(15000, () => this.socket.destroy(new Error('AMI timeout')));
      this.socket.once('error', reject);
      this.socket.on('data', (chunk) => this.#onData(chunk));
      // Banner line arrives first ("Asterisk Call Manager/x.y"), then we log in.
      this.socket.once('data', async () => {
        try {
          const res = await this.action('Login', {
            Username: this.opts.user, Secret: this.opts.password,
          });
          if (res.response.Response !== 'Success') {
            reject(new Error(`AMI login failed: ${res.response.Message}`));
          } else {
            resolve();
          }
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  #onData(chunk) {
    this.buffer += chunk;
    let sep;
    while ((sep = this.buffer.indexOf('\r\n\r\n')) !== -1) {
      const raw = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 4);
      const block = {};
      for (const line of raw.split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon > 0) block[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
      }
      this.#route(block);
    }
  }

  #route(block) {
    const id = block.ActionID;
    if (!id || !this.pending.has(id)) return;
    const entry = this.pending.get(id);

    if (block.Response !== undefined) {
      entry.response = block;
      // Simple actions complete on the Response; list actions complete on
      // their terminating *Complete event.
      if (!entry.list) this.#complete(id);
    } else if (block.Event?.endsWith('Complete')) {
      this.#complete(id);
    } else if (block.Event) {
      entry.events.push(block);
    }
  }

  #complete(id) {
    const entry = this.pending.get(id);
    this.pending.delete(id);
    entry.resolve({ response: entry.response ?? {}, events: entry.events });
  }

  /**
   * @param {string} name AMI action
   * @param {object} fields
   * @param {boolean} list true when the action returns an event list
   */
  action(name, fields = {}, list = false) {
    const id = `w${++this.actionSeq}`;
    const lines = [`Action: ${name}`, `ActionID: ${id}`];
    for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`);
    this.socket.write(lines.join('\r\n') + '\r\n\r\n');
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, events: [], list });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`AMI action ${name} timed out`));
        }
      }, 10000).unref();
    });
  }

  close() {
    this.socket?.end('Action: Logoff\r\n\r\n');
    this.socket?.destroy();
  }
}

export class AsteriskConnector {
  constructor({ writer, log }) {
    this.writer = writer;
    this.log = log;
  }

  async poll(device, cred) {
    const client = new AmiClient({ host: cred.host ?? device.address, ...cred }, this.log);
    await client.connect();
    const push = (metric, value, instance = '', tags) =>
      this.writer.push({ deviceId: device.id, metric, instance, value, tags });

    try {
      const channels = await client.action('CoreShowChannels', {}, true);
      push('pbx.channels.active', channels.events.length);
      const calls = new Set(channels.events.map((e) => e.Linkedid).filter(Boolean));
      push('pbx.calls.active', calls.size);

      if (cred.pjsip !== false) {
        const endpoints = await client.action('PJSIPShowEndpoints', {}, true)
          .catch(() => ({ events: [] }));
        let online = 0, offline = 0;
        for (const e of endpoints.events) {
          if (e.Event !== 'EndpointList') continue;
          if (e.DeviceState === 'Unavailable' || e.DeviceState === 'Invalid') offline++;
          else online++;
        }
        push('pbx.peers.online', online);
        push('pbx.peers.offline', offline);
      }

      const queues = await client.action('QueueStatus', {}, true).catch(() => ({ events: [] }));
      for (const e of queues.events) {
        if (e.Event === 'QueueParams' && e.Queue) {
          push('pbx.queue.calls', Number(e.Calls ?? 0), e.Queue);
          push('pbx.queue.holdtime.s', Number(e.Holdtime ?? 0), e.Queue);
          push('pbx.queue.abandoned', Number(e.Abandoned ?? 0), e.Queue);
        }
      }
    } finally {
      client.close();
    }
  }
}
