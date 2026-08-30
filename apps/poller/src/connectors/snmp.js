/**
 * SNMP connector — v1 / v2c / v3 via net-snmp.
 *
 * Per poll cycle for a device:
 *   - system group (sysDescr/sysName/sysUpTime)
 *   - interface table (IF-MIB, 64-bit HC counters) → bps/pps/errors rates
 *   - host resources (CPU load per core, storage) where implemented
 *
 * Credentials object shapes (stored encrypted in Postgres `credentials`):
 *   v1/v2c: { version: '2c', community: 'public', port?: 161 }
 *   v3:     { version: '3', user, level: 'authPriv'|'authNoPriv'|'noAuthNoPriv',
 *             authProtocol: 'sha'|'md5', authKey, privProtocol: 'aes'|'des', privKey }
 */
import snmp from 'net-snmp';

const OIDS = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysObjectID: '1.3.6.1.2.1.1.2.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysName: '1.3.6.1.2.1.1.5.0',

  ifTable: {
    descr: '1.3.6.1.2.1.2.2.1.2',
    operStatus: '1.3.6.1.2.1.2.2.1.8',
    // 64-bit high-capacity counters (IF-MIB::ifXTable)
    hcInOctets: '1.3.6.1.2.1.31.1.1.1.6',
    hcOutOctets: '1.3.6.1.2.1.31.1.1.1.10',
    inErrors: '1.3.6.1.2.1.2.2.1.14',
    outErrors: '1.3.6.1.2.1.2.2.1.20',
    highSpeed: '1.3.6.1.2.1.31.1.1.1.15', // Mbps
    alias: '1.3.6.1.2.1.31.1.1.1.18',
  },

  // UCD-SNMP (Linux servers)
  ucdLoad1: '1.3.6.1.4.1.2021.10.1.3.1',
  ucdMemAvail: '1.3.6.1.4.1.2021.4.6.0',
  ucdMemTotal: '1.3.6.1.4.1.2021.4.5.0',

  // HOST-RESOURCES-MIB
  hrProcessorLoad: '1.3.6.1.2.1.25.3.3.1.2',
};

function createSession(address, cred) {
  const port = cred.port ?? 161;
  if (cred.version === '3') {
    const level = {
      noAuthNoPriv: snmp.SecurityLevel.noAuthNoPriv,
      authNoPriv: snmp.SecurityLevel.authNoPriv,
      authPriv: snmp.SecurityLevel.authPriv,
    }[cred.level ?? 'authPriv'];
    const user = {
      name: cred.user,
      level,
      authProtocol: cred.authProtocol === 'md5' ? snmp.AuthProtocols.md5 : snmp.AuthProtocols.sha,
      authKey: cred.authKey,
      privProtocol: cred.privProtocol === 'des' ? snmp.PrivProtocols.des : snmp.PrivProtocols.aes,
      privKey: cred.privKey,
    };
    return snmp.createV3Session(address, user, { port, timeout: 5000 });
  }
  const version = cred.version === '1' ? snmp.Version1 : snmp.Version2c;
  return snmp.createSession(address, cred.community ?? 'public', { port, version, timeout: 5000 });
}

function get(session, oids) {
  return new Promise((resolve, reject) => {
    session.get(oids, (err, varbinds) => {
      if (err) return reject(err);
      const out = {};
      for (const vb of varbinds) {
        if (!snmp.isVarbindError(vb)) out[vb.oid] = vb.value;
      }
      resolve(out);
    });
  });
}

/** Walk a column OID → Map<ifIndex, value>. */
function walkColumn(session, baseOid) {
  return new Promise((resolve, reject) => {
    const out = new Map();
    session.subtree(baseOid,
      (varbinds) => {
        for (const vb of varbinds) {
          if (snmp.isVarbindError(vb)) continue;
          const index = vb.oid.slice(baseOid.length + 1);
          out.set(index, vb.value);
        }
      },
      (err) => (err ? reject(err) : resolve(out)));
  });
}

/** BigInt-exact reading, preserving full Counter64 precision (net-snmp
 *  returns Counter64 as a Buffer). Use for counters fed to the rate engine. */
function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (Buffer.isBuffer(value)) {
    let n = 0n;
    for (const byte of value) n = (n << 8n) | BigInt(byte);
    return n;
  }
  return BigInt(Math.trunc(Number(value)));
}

/** Lossy Number reading — fine for gauges (utilization %, load, speed) that
 *  never approach 2^53. */
function toNumber(value) {
  if (Buffer.isBuffer(value)) return Number(toBigInt(value));
  return Number(value);
}

export class SnmpConnector {
  /**
   * @param {object} deps { writer: MetricWriter, rates: RateCalculator, log }
   */
  constructor({ writer, rates, log }) {
    this.writer = writer;
    this.rates = rates;
    this.log = log;
  }

  /** Identity probe used by discovery. */
  async identify(address, cred) {
    const session = createSession(address, cred);
    try {
      const values = await get(session, [OIDS.sysDescr, OIDS.sysName, OIDS.sysObjectID]);
      const descr = String(values[OIDS.sysDescr] ?? '');
      return {
        name: String(values[OIDS.sysName] ?? '') || undefined,
        os: descr.slice(0, 255) || undefined,
        kind: /switch/i.test(descr) ? 'switch'
          : /rout/i.test(descr) ? 'router'
          : /linux/i.test(descr) ? 'server'
          : undefined,
      };
    } finally {
      session.close();
    }
  }

  /**
   * One full poll of a device. Emits metrics through the writer.
   * @param {{id: string, address: string}} device
   * @param {object} cred decrypted credential blob
   * @param {object} [cfg] poll_assignments.config, e.g. {ifFilter: '^(Gi|Te)'}
   */
  async poll(device, cred, cfg = {}) {
    const session = createSession(device.address, cred);
    try {
      await this.#pollSystem(session, device);
      await this.#pollInterfaces(session, device, cfg);
      await this.#pollHostResources(session, device);
    } finally {
      session.close();
    }
  }

  async #pollSystem(session, device) {
    const values = await get(session, [OIDS.sysUpTime]);
    const upTicks = values[OIDS.sysUpTime];
    if (upTicks !== undefined) {
      this.writer.push({
        deviceId: device.id, metric: 'sys.uptime.s', value: toNumber(upTicks) / 100,
      });
    }
  }

  async #pollInterfaces(session, device, cfg) {
    const t = OIDS.ifTable;
    const [descr, oper, inOct, outOct, inErr, outErr, speed] = await Promise.all([
      walkColumn(session, t.descr),
      walkColumn(session, t.operStatus),
      walkColumn(session, t.hcInOctets),
      walkColumn(session, t.hcOutOctets),
      walkColumn(session, t.inErrors),
      walkColumn(session, t.outErrors),
      walkColumn(session, t.highSpeed),
    ]);

    const filter = cfg.ifFilter ? new RegExp(cfg.ifFilter) : null;

    for (const [index, rawName] of descr) {
      const ifName = String(rawName);
      if (filter && !filter.test(ifName)) continue;

      const up = Number(oper.get(index)) === 1;
      this.writer.push({
        deviceId: device.id, metric: 'if.oper.up', instance: ifName, value: up ? 1 : 0,
      });
      if (!up) continue;

      const counters = [
        ['if.in.bps', inOct.get(index), 8, true],
        ['if.out.bps', outOct.get(index), 8, true],
        ['if.in.errors.ps', inErr.get(index), 1, false],
        ['if.out.errors.ps', outErr.get(index), 1, false],
      ];
      for (const [metric, raw, scale, is64] of counters) {
        if (raw === undefined) continue;
        // BigInt-exact counter value → rate engine (issue M1).
        const rate = await this.rates.rate(device.id, metric, ifName, toBigInt(raw), { is64 });
        if (rate !== null) {
          this.writer.push({ deviceId: device.id, metric, instance: ifName, value: rate * scale });
        }
      }

      // Utilization % when the interface reports a speed.
      const mbps = toNumber(speed.get(index) ?? 0);
      if (mbps > 0) {
        const inRate = await this.redisPeek(device.id, 'if.in.bps', ifName);
        if (inRate !== null) {
          this.writer.push({
            deviceId: device.id, metric: 'if.util.pct', instance: ifName,
            value: Math.min(100, (inRate / (mbps * 1e6)) * 100),
          });
        }
      }
    }
  }

  /** Read back the last computed in-rate without disturbing rate state. */
  async redisPeek(deviceId, metric, instance) {
    // The rate calculator stores raw counters, not rates; utilization uses the
    // last written rate instead. Cheap approach: recompute from the sample we
    // just pushed — the writer buffer still holds it.
    const pending = this.writer.buffer.findLast?.(
      (r) => r.deviceId === deviceId && r.metric === metric && r.instance === instance);
    return pending ? pending.value : null;
  }

  async #pollHostResources(session, device) {
    try {
      const cores = await walkColumn(session, OIDS.hrProcessorLoad);
      if (cores.size > 0) {
        let sum = 0;
        for (const [core, load] of cores) {
          const value = toNumber(load);
          sum += value;
          this.writer.push({ deviceId: device.id, metric: 'cpu.core.pct', instance: `core${core}`, value });
        }
        this.writer.push({ deviceId: device.id, metric: 'cpu.util.pct', value: sum / cores.size });
      }

      const mem = await get(session, [OIDS.ucdMemAvail, OIDS.ucdMemTotal]).catch(() => ({}));
      const total = toNumber(mem[OIDS.ucdMemTotal] ?? 0);
      const avail = toNumber(mem[OIDS.ucdMemAvail] ?? 0);
      if (total > 0) {
        this.writer.push({
          deviceId: device.id, metric: 'mem.used.pct',
          value: ((total - avail) / total) * 100,
        });
      }
    } catch {
      // Device doesn't speak HOST-RESOURCES / UCD — that's fine for switches.
    }
  }

  /**
   * Walk the LLDP-MIB remote-systems table for auto-topology. Returns the raw
   * column walks (adapted to {oid, value} rows for the pure parser) plus an
   * ifIndex→ifDescr map for readable local port names. Devices without LLDP
   * simply return empty walks.
   */
  async walkLldp(address, cred) {
    const LLDP = {
      remSysName: '1.0.8802.1.1.2.1.4.1.1.9',
      remPortId: '1.0.8802.1.1.2.1.4.1.1.7',
      remPortDesc: '1.0.8802.1.1.2.1.4.1.1.8',
    };
    const session = createSession(address, cred);
    try {
      const [sysNames, portIds, portDescs, ifDescrs] = await Promise.all([
        walkColumn(session, LLDP.remSysName),
        walkColumn(session, LLDP.remPortId),
        walkColumn(session, LLDP.remPortDesc),
        walkColumn(session, OIDS.ifTable.descr),
      ]);
      const rows = (base, map) =>
        [...map].map(([suffix, value]) => ({ oid: `${base}.${suffix}`, value: String(value) }));
      return {
        remSysNames: rows(LLDP.remSysName, sysNames),
        remPortIds: rows(LLDP.remPortId, portIds),
        remPortDescs: rows(LLDP.remPortDesc, portDescs),
        ifNames: new Map([...ifDescrs].map(([suffix, value]) => [Number(suffix), String(value)])),
      };
    } finally {
      session.close();
    }
  }
}
