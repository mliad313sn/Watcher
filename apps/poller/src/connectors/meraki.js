/**
 * Cisco Meraki Dashboard API connector (wireless controllers & APs).
 *
 * Uses the v1 REST API with:
 *   - bearer auth (X-Cisco-Meraki-API-Key header also supported; bearer is
 *     the current recommendation),
 *   - Link-header pagination,
 *   - client-side rate limiting (Meraki allows ~10 req/s per org; we stay
 *     conservative at 5) with 429 Retry-After handling.
 *
 * Synced data:
 *   - organization devices → upserted into the Watcher inventory
 *   - device availability  → device.up metric + Redis live state
 *   - wireless status      → per-AP client counts, channel utilization
 */

export class MerakiConnector {
  /**
   * @param {object} opts { apiKey, baseUrl, orgId }
   * @param {object} deps { writer, pg, log, fetchImpl }
   */
  constructor(opts, { writer, pg, log, fetchImpl = fetch }) {
    this.opts = opts;
    this.writer = writer;
    this.pg = pg;
    this.log = log;
    this.fetch = fetchImpl;
    this.minIntervalMs = 200; // 5 req/s
    this.lastRequestAt = 0;
  }

  async #throttle() {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  /** GET with pagination + 429 backoff. Returns the merged JSON array/object. */
  async get(path, { paginate = true } = {}) {
    let url = `${this.opts.baseUrl}${path}`;
    const results = [];

    for (let hop = 0; url && hop < 50; hop++) {
      await this.#throttle();
      const res = await this.fetch(url, {
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          Accept: 'application/json',
        },
      });

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('Retry-After') ?? 2);
        this.log.warn({ url, retryAfter }, 'meraki rate limited');
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        hop--; // retry same URL
        continue;
      }
      if (!res.ok) {
        throw new Error(`Meraki API ${res.status} for ${path}`);
      }

      const body = await res.json();
      if (!Array.isArray(body)) return body;
      results.push(...body);

      url = paginate ? parseNextLink(res.headers.get('Link')) : null;
    }
    return results;
  }

  /** Sync org inventory into the devices table (kind: wireless_ap / switch / …). */
  async syncInventory(tenantId) {
    const devices = await this.get(`/organizations/${this.opts.orgId}/devices`);
    for (const d of devices) {
      const kind = d.productType === 'wireless' ? 'wireless_ap'
        : d.productType === 'switch' ? 'switch'
        : d.productType === 'appliance' ? 'firewall'
        : 'other';
      await this.pg.query(
        `INSERT INTO devices (tenant_id, name, address, kind, vendor, model, tags)
         VALUES ($1, $2, NULLIF($3, '')::inet, $4::device_kind, 'Cisco Meraki', $5,
                 jsonb_build_object('merakiSerial', $6::text, 'merakiNetwork', $7::text))
         ON CONFLICT (tenant_id, name) DO UPDATE SET
           address = EXCLUDED.address, model = EXCLUDED.model, tags = devices.tags || EXCLUDED.tags`,
        [tenantId, d.name || d.serial, d.lanIp ?? '', kind, d.model, d.serial, d.networkId ?? ''],
      );
    }
    this.log.info({ count: devices.length }, 'meraki inventory synced');
    return devices.length;
  }

  /** Availability poll: 1 = online, 0 = offline/alerting/dormant. */
  async pollAvailability() {
    const statuses = await this.get(
      `/organizations/${this.opts.orgId}/devices/availabilities`);
    for (const s of statuses) {
      const device = await this.#deviceBySerial(s.serial);
      if (!device) continue;
      this.writer.push({
        deviceId: device.id,
        metric: 'device.up',
        value: s.status === 'online' ? 1 : 0,
        tags: { status: s.status },
      });
    }
    return statuses.length;
  }

  /** Wireless health: per-AP connected clients + channel utilization. */
  async pollWireless() {
    const serials = await this.pg.query(
      `SELECT id, tags->>'merakiSerial' AS serial, tags->>'merakiNetwork' AS network
       FROM devices WHERE kind = 'wireless_ap' AND tags ? 'merakiSerial'`);

    const byNetwork = new Map();
    for (const row of serials.rows) {
      if (!row.network) continue;
      if (!byNetwork.has(row.network)) byNetwork.set(row.network, []);
      byNetwork.get(row.network).push(row);
    }

    for (const [networkId, aps] of byNetwork) {
      const clients = await this.get(
        `/networks/${networkId}/clients?perPage=1000&timespan=300`).catch(() => []);
      const perAp = new Map();
      for (const c of clients) {
        if (!c.recentDeviceSerial) continue;
        perAp.set(c.recentDeviceSerial, (perAp.get(c.recentDeviceSerial) ?? 0) + 1);
      }
      for (const ap of aps) {
        this.writer.push({
          deviceId: ap.id,
          metric: 'wifi.clients',
          value: perAp.get(ap.serial) ?? 0,
        });
      }

      const utilization = await this.get(
        `/networks/${networkId}/networkHealth/channelUtilization?perPage=100`)
        .catch(() => []);
      for (const entry of utilization) {
        const ap = aps.find((a) => a.serial === entry.serial);
        if (!ap) continue;
        for (const radio of entry.wifi ?? []) {
          this.writer.push({
            deviceId: ap.id,
            metric: 'wifi.channel.util.pct',
            instance: radio.radio ?? '',
            value: radio.utilization ?? 0,
          });
        }
      }
    }
  }

  async #deviceBySerial(serial) {
    const { rows } = await this.pg.query(
      "SELECT id FROM devices WHERE tags->>'merakiSerial' = $1 LIMIT 1", [serial]);
    return rows[0] ?? null;
  }
}

/** Parse RFC 5988 Link header, return the rel="next" URL or null. */
export function parseNextLink(header) {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel=(?:"next"|next)/);
    if (m) return m[1];
  }
  return null;
}
