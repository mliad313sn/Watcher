import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LLDP_OIDS, lldpIndexOf, parseLldpNeighbors, normalizeSysName, linksFromNeighbors,
} from '../src/lldp.js';

const S = LLDP_OIDS.remSysName;
const P = LLDP_OIDS.remPortId;
const D = LLDP_OIDS.remPortDesc;

test('lldpIndexOf extracts the local port from the row index', () => {
  // timeMark=0, localPort=12, remIndex=1
  assert.deepEqual(lldpIndexOf(`${S}.0.12.1`), { localPort: 12, remIndex: 1, key: '12.1' });
  assert.equal(lldpIndexOf('1.2'), null);
});

test('parseLldpNeighbors merges the three column walks by row', () => {
  const neighbors = parseLldpNeighbors({
    remSysNames: [
      { oid: `${S}.0.1.1`, value: 'core-sw-02.corp.example.org' },
      { oid: `${S}.0.24.1`, value: 'edge-fw-01' },
    ],
    remPortIds: [
      { oid: `${P}.0.1.1`, value: 'aa:bb:cc:dd:ee:01' },
      { oid: `${P}.0.24.1`, value: 'Gi0/1' },
    ],
    remPortDescs: [
      { oid: `${D}.0.1.1`, value: 'TenGigabitEthernet1/1' },
    ],
  });
  assert.equal(neighbors.length, 2);
  const n1 = neighbors.find((n) => n.localPort === 1);
  assert.equal(n1.remoteName, 'core-sw-02.corp.example.org');
  assert.equal(n1.remotePort, 'TenGigabitEthernet1/1'); // desc preferred over raw MAC id
  const n24 = neighbors.find((n) => n.localPort === 24);
  assert.equal(n24.remotePort, 'Gi0/1'); // no desc → falls back to port-id
});

test('rows without a sysName are dropped (nothing to link to)', () => {
  const neighbors = parseLldpNeighbors({
    remSysNames: [],
    remPortIds: [{ oid: `${P}.0.3.1`, value: 'Gi0/3' }],
  });
  assert.equal(neighbors.length, 0);
});

test('normalizeSysName strips domain and case', () => {
  assert.equal(normalizeSysName('Core-SW-02.corp.example.org'), 'core-sw-02');
  assert.equal(normalizeSysName('  EDGE-FW-01  '), 'edge-fw-01');
});

test('linksFromNeighbors resolves inventory, canonicalizes edge direction, reports unknowns', () => {
  const local = { id: 'bbbb', name: 'dist-sw-01', tenant_id: 't1' };
  const inventory = new Map([
    ['core-sw-02', { id: 'aaaa', name: 'core-sw-02', tenant_id: 't1' }],
    ['dist-sw-01', local],
  ]);
  const { links, unknown } = linksFromNeighbors(local, [
    { localPort: 1, remoteName: 'Core-SW-02.corp.example.org', remotePort: 'Te1/1' },
    { localPort: 2, remoteName: 'mystery-box', remotePort: 'x' },
    { localPort: 3, remoteName: 'dist-sw-01', remotePort: 'stack' }, // self
  ], inventory, new Map([[1, 'Gi1/0/1']]));

  assert.equal(links.length, 1);
  const l = links[0];
  // 'aaaa' < 'bbbb' → remote becomes side A, so the edge is canonical.
  assert.equal(l.aDeviceId, 'aaaa');
  assert.equal(l.bDeviceId, 'bbbb');
  assert.equal(l.aIfname, 'Te1/1');
  assert.equal(l.bIfname, 'Gi1/0/1');
  assert.deepEqual(unknown, ['mystery-box']);
});
