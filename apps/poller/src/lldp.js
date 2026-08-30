/**
 * LLDP auto-topology.
 *
 * Walks the LLDP-MIB remote-systems table on every SNMP-capable device and
 * turns "switch A port Gi1/0/1 sees sysName core-sw-02 on its Te1/1" into
 * topology_links rows — the same table the topology map and the correlation
 * engine's dependency logic read. Links carry source='lldp' and a last_seen
 * stamp; re-discovery refreshes them, and stale links age out of the map.
 *
 * The OID → row mapping and the inventory name-matching are pure functions so
 * they're unit-testable without a switch in the room.
 */

export const LLDP_OIDS = {
  remSysName: '1.0.8802.1.1.2.1.4.1.1.9',   // lldpRemSysName
  remPortId: '1.0.8802.1.1.2.1.4.1.1.7',    // lldpRemPortId
  remPortDesc: '1.0.8802.1.1.2.1.4.1.1.8',  // lldpRemPortDesc
};

/**
 * The LLDP remote table is indexed by
 *   lldpRemTimeMark . lldpRemLocalPortNum . lldpRemIndex
 * so the LOCAL port number is the second-to-last OID component.
 */
export function lldpIndexOf(oid) {
  const parts = String(oid).split('.');
  if (parts.length < 3) return null;
  const localPort = Number(parts[parts.length - 2]);
  const remIndex = Number(parts[parts.length - 1]);
  if (!Number.isFinite(localPort) || !Number.isFinite(remIndex)) return null;
  return { localPort, remIndex, key: `${localPort}.${remIndex}` };
}

/**
 * Merge the three column walks into neighbor entries.
 * @param {{remSysNames: Array<{oid,value}>, remPortIds?: Array, remPortDescs?: Array}} walks
 * @returns {Array<{localPort: number, remoteName: string, remotePort: string}>}
 */
export function parseLldpNeighbors(walks) {
  const byKey = new Map();
  const put = (rows, field) => {
    for (const r of rows ?? []) {
      const idx = lldpIndexOf(r.oid);
      if (!idx) continue;
      const entry = byKey.get(idx.key) ?? { localPort: idx.localPort };
      entry[field] = String(r.value ?? '').trim();
      byKey.set(idx.key, entry);
    }
  };
  put(walks.remSysNames, 'remoteName');
  put(walks.remPortIds, 'remotePortId');
  put(walks.remPortDescs, 'remotePortDesc');

  return [...byKey.values()]
    .filter((e) => e.remoteName)
    .map((e) => ({
      localPort: e.localPort,
      remoteName: e.remoteName,
      // Port description reads better than a raw MAC/ifIndex port-id.
      remotePort: e.remotePortDesc || e.remotePortId || '',
    }));
}

/** "Core-SW-02.corp.example.org" and "core-sw-02" are the same box. */
export function normalizeSysName(name) {
  return String(name ?? '').trim().toLowerCase().split('.')[0];
}

/**
 * Resolve neighbors against the inventory and emit canonical link rows
 * (lower device id is always side A, so A→B and B→A collapse to one edge).
 * Neighbors that aren't in the inventory are reported, not dropped silently.
 */
export function linksFromNeighbors(localDevice, neighbors, inventoryByName, localPortNames = new Map()) {
  const links = [];
  const unknown = [];
  for (const n of neighbors) {
    const remote = inventoryByName.get(normalizeSysName(n.remoteName));
    if (!remote) { unknown.push(n.remoteName); continue; }
    if (remote.id === localDevice.id) continue; // self-report (stacks) — skip
    const aFirst = String(localDevice.id) < String(remote.id);
    const localIf = localPortNames.get(n.localPort) ?? `port ${n.localPort}`;
    links.push({
      tenantId: localDevice.tenant_id,
      aDeviceId: aFirst ? localDevice.id : remote.id,
      bDeviceId: aFirst ? remote.id : localDevice.id,
      aIfname: aFirst ? localIf : n.remotePort,
      bIfname: aFirst ? n.remotePort : localIf,
    });
  }
  return { links, unknown: [...new Set(unknown)] };
}

/**
 * Discovery pass: walk LLDP on each SNMP device and upsert the links.
 * @param {{pg, log}} deps
 * @param {(device, cred) => Promise<{remSysNames,remPortIds,remPortDescs, ifNames?: Map}>} walkFn
 */
export async function discoverLldpTopology({ pg, log }, walkFn) {
  const { rows: targets } = await pg.query(
    `SELECT DISTINCT ON (d.id)
            d.id, d.name, d.tenant_id, d.address, c.data_enc
     FROM devices d
     JOIN poll_assignments pa ON pa.device_id = d.id AND pa.enabled AND pa.protocol = 'snmp'
     JOIN credentials c ON c.id = pa.credential_id
     WHERE d.monitored AND d.address IS NOT NULL
     ORDER BY d.id
     LIMIT 500`);
  if (targets.length === 0) return { devices: 0, links: 0 };

  const { rows: inv } = await pg.query('SELECT id, name, tenant_id FROM devices');
  const byName = new Map(inv.map((d) => [normalizeSysName(d.name), d]));

  let total = 0;
  for (const device of targets) {
    try {
      const walks = await walkFn(device);
      if (!walks) continue;
      const neighbors = parseLldpNeighbors(walks);
      const { links, unknown } = linksFromNeighbors(device, neighbors, byName, walks.ifNames);
      if (unknown.length) {
        log.info({ device: device.name, unknown }, 'LLDP neighbors not in inventory (add them to link)');
      }
      for (const l of links) {
        await pg.query(
          `INSERT INTO topology_links (tenant_id, a_device_id, b_device_id, a_ifname, b_ifname, layer, source, last_seen)
           VALUES ($1, $2, $3, $4, $5, 'l2', 'lldp', now())
           ON CONFLICT (a_device_id, a_ifname, b_device_id, b_ifname)
           DO UPDATE SET last_seen = now(), source = 'lldp'`,
          [l.tenantId, l.aDeviceId, l.bDeviceId, l.aIfname, l.bIfname]);
        total++;
      }
    } catch (err) {
      log.warn({ device: device.name, err: err.message }, 'LLDP walk failed');
    }
  }
  return { devices: targets.length, links: total };
}
