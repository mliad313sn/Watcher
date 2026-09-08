/**
 * Flow decoding, against packets built byte by byte to the specifications.
 *
 * Binary protocol parsers fail silently — a misaligned field yields a
 * plausible-looking wrong number rather than an error — so these tests
 * assert exact values from exactly constructed datagrams, and cover the
 * truncation and out-of-order cases that a real collector meets on day one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeFlowPacket, decodeNetflowV5, decodeNetflowV9, decodeIpfix, decodeSflow,
  decodeEthernet, serviceName, protocolName, aggregationKey,
} from '@watcher/shared/flow';
import { FlowAggregator } from '../src/receivers/flow.js';

/* ── builders ──────────────────────────────────────────────────────────── */

function netflowV5(flows) {
  const buf = Buffer.alloc(24 + flows.length * 48);
  buf.writeUInt16BE(5, 0);
  buf.writeUInt16BE(flows.length, 2);
  flows.forEach((f, i) => {
    const at = 24 + i * 48;
    for (const [j, o] of f.src.split('.').entries()) buf.writeUInt8(Number(o), at + j);
    for (const [j, o] of f.dst.split('.').entries()) buf.writeUInt8(Number(o), at + 4 + j);
    buf.writeUInt16BE(f.inIf ?? 1, at + 12);
    buf.writeUInt16BE(f.outIf ?? 2, at + 14);
    buf.writeUInt32BE(f.packets, at + 16);
    buf.writeUInt32BE(f.bytes, at + 20);
    buf.writeUInt16BE(f.srcPort, at + 32);
    buf.writeUInt16BE(f.dstPort, at + 34);
    buf.writeUInt8(f.tcpFlags ?? 0, at + 37);
    buf.writeUInt8(f.protocol, at + 38);
    buf.writeUInt16BE(f.srcAs ?? 0, at + 40);
    buf.writeUInt16BE(f.dstAs ?? 0, at + 42);
  });
  return buf;
}

/** A v9 template set, and a data set, in whichever order the caller wants. */
function v9TemplateSet(templateId, fields) {
  const body = Buffer.alloc(4 + fields.length * 4);
  body.writeUInt16BE(templateId, 0);
  body.writeUInt16BE(fields.length, 2);
  fields.forEach(([type, length], i) => {
    body.writeUInt16BE(type, 4 + i * 4);
    body.writeUInt16BE(length, 6 + i * 4);
  });
  const set = Buffer.alloc(4 + body.length);
  set.writeUInt16BE(0, 0);
  set.writeUInt16BE(set.length, 2);
  body.copy(set, 4);
  return set;
}

function v9DataSet(templateId, payload) {
  const set = Buffer.alloc(4 + payload.length);
  set.writeUInt16BE(templateId, 0);
  set.writeUInt16BE(set.length, 2);
  payload.copy(set, 4);
  return set;
}

function v9Packet(sets, sourceId = 7) {
  const header = Buffer.alloc(20);
  header.writeUInt16BE(9, 0);
  header.writeUInt16BE(1, 2);
  header.writeUInt32BE(sourceId, 16);
  return Buffer.concat([header, ...sets]);
}

const ip = (s) => Buffer.from(s.split('.').map(Number));

/* ── NetFlow v5 ────────────────────────────────────────────────────────── */

test('a v5 datagram decodes every field of every record', () => {
  const buf = netflowV5([
    { src: '10.0.0.5', dst: '10.0.1.9', srcPort: 51234, dstPort: 443,
      protocol: 6, bytes: 1_500_000, packets: 1200, inIf: 3, outIf: 4,
      tcpFlags: 0x18, srcAs: 64512, dstAs: 15169 },
    { src: '10.0.0.6', dst: '8.8.8.8', srcPort: 40000, dstPort: 53,
      protocol: 17, bytes: 900, packets: 6 },
  ]);
  const { version, records } = decodeNetflowV5(buf);
  assert.equal(version, 5);
  assert.equal(records.length, 2);

  const [a, b] = records;
  assert.equal(a.srcAddr, '10.0.0.5');
  assert.equal(a.dstAddr, '10.0.1.9');
  assert.equal(a.srcPort, 51234);
  assert.equal(a.dstPort, 443);
  assert.equal(a.protocol, 6);
  assert.equal(a.bytes, 1_500_000);
  assert.equal(a.packets, 1200);
  assert.equal(a.inputIf, 3);
  assert.equal(a.outputIf, 4);
  assert.equal(a.tcpFlags, 0x18);
  assert.equal(a.srcAs, 64512);
  assert.equal(a.dstAs, 15169);
  assert.equal(b.protocol, 17);
  assert.equal(b.dstPort, 53);
});

test('a v5 datagram claiming more records than it carries is read to its real end', () => {
  // Truncation in transit, or a lie. Either way the collector must not read
  // off the end of the buffer.
  const buf = netflowV5([{ src: '1.1.1.1', dst: '2.2.2.2', srcPort: 1, dstPort: 2,
    protocol: 6, bytes: 10, packets: 1 }]);
  buf.writeUInt16BE(30, 2);
  const { records, pending } = decodeNetflowV5(buf);
  assert.equal(records.length, 1);
  assert.equal(pending, 29);
});

/* ── NetFlow v9 ────────────────────────────────────────────────────────── */

const V9_FIELDS = [
  [8, 4],    // IPV4_SRC_ADDR
  [12, 4],   // IPV4_DST_ADDR
  [7, 2],    // L4_SRC_PORT
  [11, 2],   // L4_DST_PORT
  [4, 1],    // PROTOCOL
  [1, 4],    // IN_BYTES
  [2, 4],    // IN_PKTS
  [10, 2],   // INPUT_SNMP
];

function v9Payload(src, dst, srcPort, dstPort, protocol, bytes, packets, inIf) {
  const b = Buffer.alloc(23);
  ip(src).copy(b, 0);
  ip(dst).copy(b, 4);
  b.writeUInt16BE(srcPort, 8);
  b.writeUInt16BE(dstPort, 10);
  b.writeUInt8(protocol, 12);
  b.writeUInt32BE(bytes, 13);
  b.writeUInt32BE(packets, 17);
  b.writeUInt16BE(inIf, 21);
  return b;
}

test('a v9 template and its data in one datagram decode', () => {
  const templates = new Map();
  const packet = v9Packet([
    v9TemplateSet(256, V9_FIELDS),
    v9DataSet(256, v9Payload('192.168.1.10', '192.168.2.20', 33000, 22, 6, 5000, 40, 9)),
  ]);
  const { version, records, templatesLearned } = decodeNetflowV9(packet, templates, '10.0.0.1');
  assert.equal(version, 9);
  assert.equal(templatesLearned, 1);
  assert.equal(records.length, 1);
  assert.deepEqual(
    { s: records[0].srcAddr, d: records[0].dstAddr, p: records[0].dstPort,
      b: records[0].bytes, k: records[0].packets, i: records[0].inputIf },
    { s: '192.168.1.10', d: '192.168.2.20', p: 22, b: 5000, k: 40, i: 9 });
});

test('data before its template is counted as pending, not silently lost', () => {
  // Every real deployment starts here: the collector comes up mid-stream and
  // is deaf until the exporter next re-sends its templates. "Waiting for a
  // template" and "nothing is arriving" need different fixes, so they are
  // reported differently.
  const templates = new Map();
  const orphan = decodeNetflowV9(
    v9Packet([v9DataSet(256, v9Payload('1.1.1.1', '2.2.2.2', 1, 2, 6, 1, 1, 1))]),
    templates, '10.0.0.1');
  assert.equal(orphan.records.length, 0);
  assert.equal(orphan.pending, 1);

  // …and once the template arrives, later data decodes.
  decodeNetflowV9(v9Packet([v9TemplateSet(256, V9_FIELDS)]), templates, '10.0.0.1');
  const later = decodeNetflowV9(
    v9Packet([v9DataSet(256, v9Payload('1.1.1.1', '2.2.2.2', 1, 2, 6, 4242, 3, 1))]),
    templates, '10.0.0.1');
  assert.equal(later.records.length, 1);
  assert.equal(later.records[0].bytes, 4242);
});

test('templates are scoped to the exporter that sent them', () => {
  // Two routers may both use template id 256 with different shapes. Sharing
  // one cache across exporters decodes one of them into nonsense.
  const templates = new Map();
  decodeNetflowV9(v9Packet([v9TemplateSet(256, V9_FIELDS)]), templates, '10.0.0.1');
  const other = decodeNetflowV9(
    v9Packet([v9DataSet(256, v9Payload('1.1.1.1', '2.2.2.2', 1, 2, 6, 1, 1, 1))]),
    templates, '10.0.0.2');
  assert.equal(other.records.length, 0);
  assert.equal(other.pending, 1);
});

test('templates are scoped to the observation domain too', () => {
  const templates = new Map();
  decodeNetflowV9(v9Packet([v9TemplateSet(256, V9_FIELDS)], 7), templates, '10.0.0.1');
  const other = decodeNetflowV9(
    v9Packet([v9DataSet(256, v9Payload('1.1.1.1', '2.2.2.2', 1, 2, 6, 1, 1, 1))], 8),
    templates, '10.0.0.1');
  assert.equal(other.pending, 1);
});

test('several data records in one set all decode', () => {
  const templates = new Map();
  decodeNetflowV9(v9Packet([v9TemplateSet(256, V9_FIELDS)]), templates, '10.0.0.1');
  const payload = Buffer.concat([
    v9Payload('1.1.1.1', '2.2.2.2', 1, 80, 6, 100, 1, 1),
    v9Payload('3.3.3.3', '4.4.4.4', 2, 443, 6, 200, 2, 1),
    v9Payload('5.5.5.5', '6.6.6.6', 3, 53, 17, 300, 3, 1),
  ]);
  const { records } = decodeNetflowV9(v9Packet([v9DataSet(256, payload)]), templates, '10.0.0.1');
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((r) => r.bytes), [100, 200, 300]);
});

test('an unknown information element is skipped without misaligning the rest', () => {
  // The failure this prevents: an unrecognised field consuming zero bytes,
  // after which every later field reads the wrong part of the record.
  const templates = new Map();
  const fields = [[8, 4], [99, 6], [12, 4], [1, 4]];   // 99 is not one we act on
  decodeNetflowV9(v9Packet([v9TemplateSet(300, fields)]), templates, '10.0.0.1');
  const payload = Buffer.alloc(18);
  ip('10.1.1.1').copy(payload, 0);
  payload.write('ignored', 4);
  ip('10.2.2.2').copy(payload, 10);
  payload.writeUInt32BE(7777, 14);
  const { records } = decodeNetflowV9(v9Packet([v9DataSet(300, payload)]), templates, '10.0.0.1');
  assert.equal(records.length, 1);
  assert.equal(records[0].srcAddr, '10.1.1.1');
  assert.equal(records[0].dstAddr, '10.2.2.2');
  assert.equal(records[0].bytes, 7777);
});

test('a re-sent template replaces the one held', () => {
  const templates = new Map();
  decodeNetflowV9(v9Packet([v9TemplateSet(256, V9_FIELDS)]), templates, '10.0.0.1');
  decodeNetflowV9(v9Packet([v9TemplateSet(256, [[8, 4], [12, 4], [1, 4]])]), templates, '10.0.0.1');
  const payload = Buffer.alloc(12);
  ip('9.9.9.9').copy(payload, 0);
  ip('8.8.8.8').copy(payload, 4);
  payload.writeUInt32BE(555, 8);
  const { records } = decodeNetflowV9(v9Packet([v9DataSet(256, payload)]), templates, '10.0.0.1');
  assert.equal(records[0].srcAddr, '9.9.9.9');
  assert.equal(records[0].bytes, 555);
});

/* ── IPFIX ─────────────────────────────────────────────────────────────── */

function ipfixPacket(sets, domain = 1) {
  const header = Buffer.alloc(16);
  header.writeUInt16BE(10, 0);
  header.writeUInt32BE(domain, 12);
  const whole = Buffer.concat([header, ...sets]);
  whole.writeUInt16BE(whole.length, 2);
  return whole;
}

function ipfixTemplateSet(templateId, fields) {
  const body = Buffer.alloc(4 + fields.length * 4);
  body.writeUInt16BE(templateId, 0);
  body.writeUInt16BE(fields.length, 2);
  fields.forEach(([type, length], i) => {
    body.writeUInt16BE(type, 4 + i * 4);
    body.writeUInt16BE(length, 6 + i * 4);
  });
  const set = Buffer.alloc(4 + body.length);
  set.writeUInt16BE(2, 0);
  set.writeUInt16BE(set.length, 2);
  body.copy(set, 4);
  return set;
}

test('an IPFIX template and data decode, including 64-bit counters', () => {
  const templates = new Map();
  const fields = [[8, 4], [12, 4], [4, 1], [1, 8], [2, 8]];
  const payload = Buffer.alloc(25);
  ip('172.16.0.1').copy(payload, 0);
  ip('172.16.0.2').copy(payload, 4);
  payload.writeUInt8(6, 8);
  payload.writeBigUInt64BE(9_000_000_000n, 9);       // beyond 32 bits on purpose
  payload.writeBigUInt64BE(6_000_000n, 17);
  const dataSet = Buffer.alloc(4 + payload.length);
  dataSet.writeUInt16BE(256, 0);
  dataSet.writeUInt16BE(dataSet.length, 2);
  payload.copy(dataSet, 4);

  const { version, records } = decodeIpfix(
    ipfixPacket([ipfixTemplateSet(256, fields), dataSet]), templates, '10.0.0.1');
  assert.equal(version, 10);
  assert.equal(records.length, 1);
  assert.equal(records[0].bytes, 9_000_000_000);
  assert.equal(records[0].packets, 6_000_000);
});

test('an IPFIX enterprise element consumes its PEN and does not misalign', () => {
  const templates = new Map();
  // 0x8000 | 42 marks an enterprise element, followed by a 4-byte PEN.
  const fields = [[8, 4], [0x8000 | 42, 4], [12, 4], [1, 4]];
  const body = Buffer.alloc(4 + fields.length * 4 + 4);
  body.writeUInt16BE(400, 0);
  body.writeUInt16BE(fields.length, 2);
  let at = 4;
  for (const [type, length] of fields) {
    body.writeUInt16BE(type, at);
    body.writeUInt16BE(length, at + 2);
    at += 4;
    if (type & 0x8000) { body.writeUInt32BE(9999, at); at += 4; }
  }
  const tset = Buffer.alloc(4 + body.length);
  tset.writeUInt16BE(2, 0);
  tset.writeUInt16BE(tset.length, 2);
  body.copy(tset, 4);

  const payload = Buffer.alloc(16);
  ip('10.5.5.5').copy(payload, 0);
  payload.writeUInt32BE(0xdeadbeef, 4);              // the vendor's field
  ip('10.6.6.6').copy(payload, 8);
  payload.writeUInt32BE(1234, 12);
  const dset = Buffer.alloc(4 + payload.length);
  dset.writeUInt16BE(400, 0);
  dset.writeUInt16BE(dset.length, 2);
  payload.copy(dset, 4);

  const { records } = decodeIpfix(ipfixPacket([tset, dset]), templates, '10.0.0.1');
  assert.equal(records.length, 1);
  assert.equal(records[0].srcAddr, '10.5.5.5');
  assert.equal(records[0].dstAddr, '10.6.6.6');
  assert.equal(records[0].bytes, 1234);
});

test('IPv6 addresses decode and are compressed the way people write them', () => {
  const templates = new Map();
  const fields = [[27, 16], [28, 16], [1, 4]];
  const payload = Buffer.alloc(36);
  Buffer.from('20010db8000000000000000000000001', 'hex').copy(payload, 0);
  Buffer.from('20010db8000000000000000000000002', 'hex').copy(payload, 16);
  payload.writeUInt32BE(64, 32);
  const dset = Buffer.alloc(4 + payload.length);
  dset.writeUInt16BE(256, 0);
  dset.writeUInt16BE(dset.length, 2);
  payload.copy(dset, 4);

  const { records } = decodeIpfix(
    ipfixPacket([ipfixTemplateSet(256, fields), dset]), templates, '10.0.0.1');
  assert.equal(records[0].srcAddr, '2001:db8::1');
  assert.equal(records[0].dstAddr, '2001:db8::2');
});

/* ── sFlow ─────────────────────────────────────────────────────────────── */

function ethernetIPv4(src, dst, srcPort, dstPort, protocol) {
  const frame = Buffer.alloc(54);
  frame.writeUInt16BE(0x0800, 12);
  frame.writeUInt8(0x45, 14);
  frame.writeUInt8(protocol, 23);
  ip(src).copy(frame, 26);
  ip(dst).copy(frame, 30);
  frame.writeUInt16BE(srcPort, 34);
  frame.writeUInt16BE(dstPort, 36);
  return frame;
}

test('a raw Ethernet frame yields the conversation inside it', () => {
  const frame = ethernetIPv4('10.1.1.1', '10.2.2.2', 45000, 443, 6);
  const r = decodeEthernet(frame, 0, frame.length);
  assert.equal(r.srcAddr, '10.1.1.1');
  assert.equal(r.dstAddr, '10.2.2.2');
  assert.equal(r.dstPort, 443);
  assert.equal(r.protocol, 6);
});

test('a VLAN tag is stepped over rather than read as an ethertype', () => {
  const inner = ethernetIPv4('10.3.3.3', '10.4.4.4', 1000, 80, 6);
  const tagged = Buffer.alloc(inner.length + 4);
  inner.copy(tagged, 0, 0, 12);
  tagged.writeUInt16BE(0x8100, 12);
  tagged.writeUInt16BE(100, 14);
  tagged.writeUInt16BE(0x0800, 16);
  inner.copy(tagged, 18, 14);
  const r = decodeEthernet(tagged, 0, tagged.length);
  assert.equal(r.srcAddr, '10.3.3.3');
  assert.equal(r.dstPort, 80);
});

test('a frame that is not IP is not a flow', () => {
  const arp = Buffer.alloc(20);
  arp.writeUInt16BE(0x0806, 12);
  assert.equal(decodeEthernet(arp, 0, arp.length), null);
});

test('an sFlow sample is scaled by the sampling rate', () => {
  // The number that matters: reporting the sampled frame alone under-reports
  // a 1-in-1000 sampler by three orders of magnitude.
  const frame = ethernetIPv4('10.7.7.7', '10.8.8.8', 5000, 22, 6);
  const rate = 1000;
  const frameLength = 1500;

  const raw = Buffer.alloc(16 + frame.length);
  raw.writeUInt32BE(1, 0);                 // header protocol: ethernet
  raw.writeUInt32BE(frameLength, 4);
  raw.writeUInt32BE(0, 8);                 // stripped
  raw.writeUInt32BE(frame.length, 12);
  frame.copy(raw, 16);

  const flowRecord = Buffer.alloc(8 + raw.length);
  flowRecord.writeUInt32BE(1, 0);          // raw packet header
  flowRecord.writeUInt32BE(raw.length, 4);
  raw.copy(flowRecord, 8);

  const sample = Buffer.alloc(32 + flowRecord.length);
  sample.writeUInt32BE(1, 0);              // sequence
  sample.writeUInt32BE(0, 4);              // source id
  sample.writeUInt32BE(rate, 8);
  sample.writeUInt32BE(0, 12);             // pool
  sample.writeUInt32BE(0, 16);             // drops
  sample.writeUInt32BE(11, 20);            // input ifIndex
  sample.writeUInt32BE(12, 24);            // output ifIndex
  sample.writeUInt32BE(1, 28);             // one flow record
  flowRecord.copy(sample, 32);

  const packet = Buffer.alloc(28 + 8 + sample.length);
  packet.writeUInt32BE(5, 0);              // sFlow v5
  packet.writeUInt32BE(1, 4);              // IPv4 agent
  packet.writeUInt32BE(0x0a000001, 8);
  packet.writeUInt32BE(0, 12);             // sub-agent
  packet.writeUInt32BE(1, 16);             // sequence
  packet.writeUInt32BE(0, 20);             // uptime
  packet.writeUInt32BE(1, 24);             // one sample
  packet.writeUInt32BE(1, 28);             // flow sample
  packet.writeUInt32BE(sample.length, 32);
  sample.copy(packet, 36);

  const { records } = decodeSflow(packet);
  assert.equal(records.length, 1);
  assert.equal(records[0].srcAddr, '10.7.7.7');
  assert.equal(records[0].dstPort, 22);
  assert.equal(records[0].bytes, frameLength * rate);
  assert.equal(records[0].packets, rate);
  assert.equal(records[0].inputIf, 11);
  assert.equal(records[0].sampled, true);
});

/* ── dispatch ──────────────────────────────────────────────────────────── */

test('the entry point routes each version to its decoder', () => {
  const templates = new Map();
  const v5 = decodeFlowPacket(netflowV5([{ src: '1.1.1.1', dst: '2.2.2.2', srcPort: 1,
    dstPort: 2, protocol: 6, bytes: 1, packets: 1 }]), templates, '10.0.0.1');
  assert.equal(v5.version, 5);
  assert.equal(decodeFlowPacket(v9Packet([v9TemplateSet(256, V9_FIELDS)]), templates, '10.0.0.1').version, 9);
  assert.equal(decodeFlowPacket(ipfixPacket([ipfixTemplateSet(256, [[8, 4]])]), templates, '10.0.0.1').version, 10);
});

test('something that is not flow at all returns null instead of throwing', () => {
  assert.equal(decodeFlowPacket(Buffer.from('GET / HTTP/1.1\r\n\r\n'), new Map(), '1.1.1.1'), null);
  assert.equal(decodeFlowPacket(Buffer.alloc(4), new Map(), '1.1.1.1'), null);
  assert.equal(decodeFlowPacket('not a buffer', new Map(), '1.1.1.1'), null);
});

test('a truncated datagram is refused, not half-read into wrong numbers', () => {
  const whole = v9Packet([v9TemplateSet(256, V9_FIELDS)]);
  const cut = whole.subarray(0, whole.length - 6);
  const templates = new Map();
  const out = decodeFlowPacket(cut, templates, '10.0.0.1');
  assert.equal(out.records.length, 0);
});

/* ── naming ────────────────────────────────────────────────────────────── */

test('a service is named from the well-known port of the pair', () => {
  assert.equal(serviceName(6, 51234, 443), 'https');
  assert.equal(serviceName(6, 443, 51234), 'https');      // direction must not matter
  assert.equal(serviceName(17, 40000, 53), 'dns');
});

test('an unrecognised pair is reported as its protocol, not guessed', () => {
  assert.equal(serviceName(6, 40000, 41000), 'tcp');
  assert.equal(serviceName(47, 0, 0), 'gre');
  assert.equal(protocolName(200), '200');
});

/* ── aggregation ───────────────────────────────────────────────────────── */

test('a conversation folds to the same key seen from either direction', () => {
  const out = { srcAddr: '10.0.0.1', dstAddr: '10.0.0.2', srcPort: 50000,
    dstPort: 443, protocol: 6, inputIf: 1 };
  const back = { srcAddr: '10.0.0.2', dstAddr: '10.0.0.1', srcPort: 443,
    dstPort: 50000, protocol: 6, inputIf: 1 };
  assert.equal(aggregationKey(out), aggregationKey(back));
});

test('different services between the same hosts stay apart', () => {
  const web = { srcAddr: '10.0.0.1', dstAddr: '10.0.0.2', srcPort: 5, dstPort: 443, protocol: 6, inputIf: 1 };
  const ssh = { srcAddr: '10.0.0.1', dstAddr: '10.0.0.2', srcPort: 5, dstPort: 22, protocol: 6, inputIf: 1 };
  assert.notEqual(aggregationKey(web), aggregationKey(ssh));
});

test('the aggregator sums a conversation instead of storing every record', () => {
  const agg = new FlowAggregator();
  for (let i = 0; i < 500; i++) {
    agg.add({ srcAddr: '10.0.0.1', dstAddr: '10.0.0.2', srcPort: 40000 + i,
      dstPort: 443, protocol: 6, bytes: 1000, packets: 10, inputIf: 1 }, 'e', null, 't');
  }
  assert.equal(agg.size, 1, '500 records became one row');
  const [row] = agg.drain('t');
  assert.equal(row.bytes, 500_000);
  assert.equal(row.packets, 5_000);
  assert.equal(row.flows, 500);
  assert.equal(row.service, 'https');
});

test('past the ceiling the totals stay true even though the detail cannot', () => {
  // A scan invents unique conversations as fast as the wire allows. The
  // aggregator must not grow without bound, and must not quietly lose bytes.
  const agg = new FlowAggregator({ maxKeys: 10 });
  for (let i = 0; i < 100; i++) {
    agg.add({ srcAddr: `10.0.${i}.1`, dstAddr: '10.9.9.9', srcPort: 1, dstPort: 443,
      protocol: 6, bytes: 100, packets: 1, inputIf: 1 }, 'e', null, 't');
  }
  assert.equal(agg.size, 10);
  const rows = agg.drain('t');
  assert.equal(rows.length, 11);
  const other = rows.find((r) => r.service === '(other)');
  assert.ok(other, 'the overflow is reported rather than dropped');
  assert.equal(rows.reduce((n, r) => n + r.bytes, 0), 10_000);
});

test('a record we could not read is not counted into the totals', () => {
  const agg = new FlowAggregator();
  agg.add({ srcAddr: '', dstAddr: '', bytes: 999, packets: 9, protocol: 6, inputIf: 1 }, 'e', null, 't');
  assert.equal(agg.size, 0);
  assert.equal(agg.drain('t').length, 0);
});

test('draining resets the aggregator so an interval is not double counted', () => {
  const agg = new FlowAggregator();
  agg.add({ srcAddr: '1.1.1.1', dstAddr: '2.2.2.2', srcPort: 1, dstPort: 80,
    protocol: 6, bytes: 10, packets: 1, inputIf: 1 }, 'e', null, 't');
  assert.equal(agg.drain('t').length, 1);
  assert.equal(agg.drain('t').length, 0);
});
