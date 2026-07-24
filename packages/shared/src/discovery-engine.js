/**
 * Network discovery framework (Layer 2/3).
 *
 * A discovery job sweeps a CIDR and builds/updates the device inventory and
 * topology graph. The pipeline is deliberately pluggable — each stage is a
 * "probe" with a uniform interface so new protocols slot in without touching
 * the engine:
 *
 *   1. reachability  ICMP sweep of the CIDR (which addresses answer?)
 *   2. identify      per-responder probes (SNMP sysDescr/sysObjectID,
 *                    reverse DNS, open-port fingerprint) → kind/vendor/os
 *   3. adjacency     L2: LLDP (lldpRemTable) / CDP walk on SNMP devices;
 *                    L3: ARP tables (ipNetToMedia) + route next-hops
 *   4. persist       upsert devices + topology_links; unknown neighbors
 *                    become 'other' placeholder devices for later triage
 *
 * The heavy protocol lifting (SNMP walks) reuses the poller's connector code;
 * this module owns orchestration, batching and persistence.
 */

/** Expand a CIDR (v4) into usable host addresses, capped for safety. */
export function expandCidr(cidr, cap = 4096) {
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  if (!base || Number.isNaN(bits) || bits < 8 || bits > 32) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const octets = base.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
    throw new Error(`invalid CIDR base address: ${cidr}`);
  }
  const baseInt = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const hostBits = 32 - bits;
  const network = hostBits === 0 ? baseInt : (baseInt >>> hostBits << hostBits) >>> 0;
  const total = 2 ** hostBits;

  const out = [];
  // Skip network & broadcast addresses for real subnets.
  const start = total > 2 ? 1 : 0;
  const end = total > 2 ? total - 1 : total;
  for (let i = start; i < end && out.length < cap; i++) {
    const addr = (network + i) >>> 0;
    out.push([addr >>> 24, (addr >>> 16) & 255, (addr >>> 8) & 255, addr & 255].join('.'));
  }
  return out;
}

export class DiscoveryEngine {
  /**
   * @param {object} deps
   * @param {import('pg').Pool} deps.pg
   * @param {object} deps.log
   * @param {object} [deps.probes]  injected probe implementations; each is
   *   async (address, context) => partial result or null. Defaults are wired
   *   in apps/poller (which owns the SNMP stack); the API can run with the
   *   ping-only probe for basic sweeps.
   */
  constructor({ pg, log, probes = {} }) {
    this.pg = pg;
    this.log = log;
    this.probes = probes;
  }

  /** Run one discovery job to completion. Progress lands in discovery_jobs.result. */
  async run(jobId) {
    const { rows } = await this.pg.query('SELECT * FROM discovery_jobs WHERE id = $1', [jobId]);
    const job = rows[0];
    if (!job) throw new Error(`discovery job ${jobId} not found`);

    await this.pg.query(
      `UPDATE discovery_jobs SET status = 'running', last_run_at = now() WHERE id = $1`, [jobId]);

    try {
      const addresses = expandCidr(job.cidr);
      const found = [];

      const concurrency = 64;
      for (let i = 0; i < addresses.length; i += concurrency) {
        const batch = addresses.slice(i, i + concurrency);
        const results = await Promise.allSettled(batch.map((addr) => this.#probeAddress(addr, job)));
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value) found.push(r.value);
        }
      }

      for (const dev of found) await this.#persistDevice(job.tenant_id, dev);

      await this.pg.query(
        `UPDATE discovery_jobs SET status = 'done', result = $2 WHERE id = $1`,
        [jobId, JSON.stringify({ scanned: addresses.length, found: found.length, at: new Date().toISOString() })],
      );
      return { scanned: addresses.length, found: found.length };
    } catch (err) {
      await this.pg.query(
        `UPDATE discovery_jobs SET status = 'failed', result = $2 WHERE id = $1`,
        [jobId, JSON.stringify({ error: String(err?.message ?? err) })],
      );
      throw err;
    }
  }

  async #probeAddress(address, job) {
    const alive = this.probes.ping ? await this.probes.ping(address) : false;
    if (!alive) return null;

    let identity = { address, kind: 'other' };
    if (this.probes.snmpIdentify && job.protocols.includes('snmp')) {
      const snmp = await this.probes.snmpIdentify(address, job).catch(() => null);
      if (snmp) identity = { ...identity, ...snmp };
    }
    if (this.probes.reverseDns) {
      identity.name = identity.name
        ?? await this.probes.reverseDns(address).catch(() => null)
        ?? address;
    } else {
      identity.name = identity.name ?? address;
    }
    return identity;
  }

  async #persistDevice(tenantId, dev) {
    await this.pg.query(
      `INSERT INTO devices (tenant_id, name, address, kind, vendor, os)
       VALUES ($1, $2, $3, COALESCE($4, 'other')::device_kind, $5, $6)
       ON CONFLICT (tenant_id, name) DO UPDATE SET
         address = EXCLUDED.address,
         vendor  = COALESCE(EXCLUDED.vendor, devices.vendor),
         os      = COALESCE(EXCLUDED.os, devices.os)`,
      [tenantId, dev.name, dev.address, dev.kind ?? null, dev.vendor ?? null, dev.os ?? null],
    );
  }
}
