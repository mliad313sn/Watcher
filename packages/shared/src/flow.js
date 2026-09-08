/**
 * Flow record decoding — NetFlow v5, NetFlow v9, IPFIX and sFlow v5.
 *
 * "Is it up?" is answered by a check. "Why is the link full, and who is
 * filling it?" is answered only by flow, which is why SolarWinds and Auvik
 * sell it as a separate product and why a monitoring platform without it
 * ends every bandwidth conversation with a shrug.
 *
 * Pure decoding, no I/O. The four formats reduce to one normalised record so
 * that everything above this file — aggregation, storage, the console —
 * never learns which vendor exported what.
 *
 * The hard part is not the parsing, it is that v9 and IPFIX are
 * self-describing: a data record is unintelligible until the exporter has
 * sent the template that describes it, templates are re-sent only every few
 * minutes, and they are scoped per exporter and observation domain. A
 * collector that restarts is deaf until the next template refresh. That is
 * inherent to the protocols, so the template cache is explicit here and the
 * records that could not yet be read are counted rather than silently
 * dropped — "we are waiting for a template" and "nothing is arriving" are
 * different problems with different fixes.
 */

/** IANA protocol numbers worth naming; everything else shows as its number. */
export const PROTOCOL_NAMES = Object.freeze({
  1: 'icmp', 2: 'igmp', 6: 'tcp', 17: 'udp', 41: 'ipv6', 47: 'gre',
  50: 'esp', 51: 'ah', 58: 'icmpv6', 89: 'ospf', 103: 'pim', 132: 'sctp',
});

export function protocolName(number) {
  return PROTOCOL_NAMES[number] ?? String(number);
}

/**
 * A very small port→service table. Deliberately small: guessing an
 * application from a port number is wrong often enough that a long table
 * would be confidently wrong rather than usefully vague.
 */
const SERVICE_PORTS = Object.freeze({
  20: 'ftp-data', 21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'dns',
  67: 'dhcp', 68: 'dhcp', 69: 'tftp', 80: 'http', 110: 'pop3', 123: 'ntp',
  143: 'imap', 161: 'snmp', 162: 'snmp-trap', 389: 'ldap', 443: 'https',
  445: 'smb', 465: 'smtps', 514: 'syslog', 587: 'smtp-sub', 636: 'ldaps',
  993: 'imaps', 995: 'pop3s', 1194: 'openvpn', 1433: 'mssql', 1521: 'oracle',
  3306: 'mysql', 3389: 'rdp', 5060: 'sip', 5061: 'sips', 5432: 'postgres',
  5900: 'vnc', 6379: 'redis', 8080: 'http-alt', 8443: 'https-alt', 27017: 'mongodb',
});

/**
 * Name the application behind a conversation. The lower port is the server
 * in almost every case — clients take ephemeral ports — so it is tried
 * first, and an unrecognised pair is reported as the protocol rather than
 * as a wrong guess.
 */
export function serviceName(protocol, srcPort, dstPort) {
  if (protocol !== 6 && protocol !== 17) return protocolName(protocol);
  const low = Math.min(srcPort, dstPort);
  const high = Math.max(srcPort, dstPort);
  return SERVICE_PORTS[low] ?? SERVICE_PORTS[high] ?? protocolName(protocol);
}

const ipv4 = (buf, at) => `${buf[at]}.${buf[at + 1]}.${buf[at + 2]}.${buf[at + 3]}`;

function ipv6(buf, at) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(buf.readUInt16BE(at + i).toString(16));
  // RFC 5952 §4.2: compress the longest run of zero groups, once.
  let bestStart = -1; let bestLen = 0; let runStart = -1; let runLen = 0;
  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === '0') {
      if (runStart === -1) { runStart = i; runLen = 1; } else runLen++;
    } else {
      if (runLen > bestLen) { bestLen = runLen; bestStart = runStart; }
      runStart = -1; runLen = 0;
    }
  }
  if (bestLen < 2) return groups.join(':');
  return `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLen).join(':')}`;
}

/** Read an unsigned big-endian integer of any width a flow field may use. */
function readUInt(buf, at, length) {
  switch (length) {
    case 1: return buf.readUInt8(at);
    case 2: return buf.readUInt16BE(at);
    case 3: return (buf.readUInt16BE(at) << 8) | buf.readUInt8(at + 2);
    case 4: return buf.readUInt32BE(at);
    // Counters wider than 2^53 do not occur in a flow record, and Number
    // keeps the whole pipeline free of BigInt plumbing for no real loss.
    case 8: return Number(buf.readBigUInt64BE(at));
    default: {
      let n = 0;
      for (let i = 0; i < length && i < 8; i++) n = n * 256 + buf[at + i];
      return n;
    }
  }
}

/** The normalised record every decoder produces. */
function blankRecord() {
  return {
    srcAddr: '', dstAddr: '', srcPort: 0, dstPort: 0, protocol: 0,
    bytes: 0, packets: 0, inputIf: 0, outputIf: 0,
    tos: 0, tcpFlags: 0, srcAs: 0, dstAs: 0,
  };
}

/* ── NetFlow v5 ─────────────────────────────────────────────────────────
   Fixed layout, no templates: a 24-byte header then `count` 48-byte
   records. Still the most common thing a switch will actually emit. */

const V5_HEADER = 24;
const V5_RECORD = 48;

export function decodeNetflowV5(buf) {
  const count = buf.readUInt16BE(2);
  const records = [];
  // A stated count larger than the datagram is either truncation or a lie;
  // read what is actually there rather than off the end of the buffer.
  const available = Math.floor((buf.length - V5_HEADER) / V5_RECORD);
  const n = Math.min(count, available);

  for (let i = 0; i < n; i++) {
    const at = V5_HEADER + i * V5_RECORD;
    records.push({
      ...blankRecord(),
      srcAddr: ipv4(buf, at),
      dstAddr: ipv4(buf, at + 4),
      inputIf: buf.readUInt16BE(at + 12),
      outputIf: buf.readUInt16BE(at + 14),
      packets: buf.readUInt32BE(at + 16),
      bytes: buf.readUInt32BE(at + 20),
      srcPort: buf.readUInt16BE(at + 32),
      dstPort: buf.readUInt16BE(at + 34),
      tcpFlags: buf.readUInt8(at + 37),
      protocol: buf.readUInt8(at + 38),
      tos: buf.readUInt8(at + 39),
      srcAs: buf.readUInt16BE(at + 40),
      dstAs: buf.readUInt16BE(at + 42),
    });
  }
  return { version: 5, records, pending: Math.max(0, count - n) };
}

/* ── NetFlow v9 and IPFIX ───────────────────────────────────────────────
   Same idea in two dialects: templates describe the shape of the data
   records that follow, possibly in a later datagram. The field identifiers
   overlap almost entirely, so one field decoder serves both. */

/** The v9/IPFIX information elements we act on. */
const FIELD = {
  IN_BYTES: 1, IN_PKTS: 2, PROTOCOL: 4, TOS: 5, TCP_FLAGS: 6,
  L4_SRC_PORT: 7, IPV4_SRC_ADDR: 8, INPUT_SNMP: 10,
  L4_DST_PORT: 11, IPV4_DST_ADDR: 12, OUTPUT_SNMP: 14,
  SRC_AS: 16, DST_AS: 17, IPV6_SRC_ADDR: 27, IPV6_DST_ADDR: 28,
  OUT_BYTES: 23, OUT_PKTS: 24,
};

function applyField(record, type, buf, at, length) {
  switch (type) {
    case FIELD.IN_BYTES: case FIELD.OUT_BYTES: record.bytes += readUInt(buf, at, length); break;
    case FIELD.IN_PKTS: case FIELD.OUT_PKTS: record.packets += readUInt(buf, at, length); break;
    case FIELD.PROTOCOL: record.protocol = readUInt(buf, at, length); break;
    case FIELD.TOS: record.tos = readUInt(buf, at, length); break;
    case FIELD.TCP_FLAGS: record.tcpFlags = readUInt(buf, at, length); break;
    case FIELD.L4_SRC_PORT: record.srcPort = readUInt(buf, at, length); break;
    case FIELD.L4_DST_PORT: record.dstPort = readUInt(buf, at, length); break;
    case FIELD.INPUT_SNMP: record.inputIf = readUInt(buf, at, length); break;
    case FIELD.OUTPUT_SNMP: record.outputIf = readUInt(buf, at, length); break;
    case FIELD.SRC_AS: record.srcAs = readUInt(buf, at, length); break;
    case FIELD.DST_AS: record.dstAs = readUInt(buf, at, length); break;
    case FIELD.IPV4_SRC_ADDR: if (length >= 4) record.srcAddr = ipv4(buf, at); break;
    case FIELD.IPV4_DST_ADDR: if (length >= 4) record.dstAddr = ipv4(buf, at); break;
    case FIELD.IPV6_SRC_ADDR: if (length >= 16) record.srcAddr = ipv6(buf, at); break;
    case FIELD.IPV6_DST_ADDR: if (length >= 16) record.dstAddr = ipv6(buf, at); break;
    default: break;                       // a field we do not act on is not an error
  }
}

/**
 * Decode one data set against a template.
 * Variable-length elements (IPFIX length 65535) carry their own length byte,
 * so a record's width is not always the template's nominal width.
 */
function decodeDataSet(buf, start, end, template) {
  const records = [];
  let at = start;
  while (at < end) {
    const record = blankRecord();
    let consumed = 0;
    let short = false;

    for (const field of template.fields) {
      let length = field.length;
      if (length === 65535) {                      // IPFIX variable length
        if (at + consumed >= end) { short = true; break; }
        length = buf.readUInt8(at + consumed);
        consumed += 1;
        if (length === 255) {
          if (at + consumed + 2 > end) { short = true; break; }
          length = buf.readUInt16BE(at + consumed);
          consumed += 2;
        }
      }
      if (at + consumed + length > end) { short = true; break; }
      applyField(record, field.type, buf, at + consumed, length);
      consumed += length;
    }
    if (short || consumed === 0) break;            // trailing padding, not a record
    records.push(record);
    at += consumed;
  }
  return records;
}

function readTemplateSet(buf, start, end, store, key) {
  let at = start;
  let learned = 0;
  while (at + 4 <= end) {
    const templateId = buf.readUInt16BE(at);
    const fieldCount = buf.readUInt16BE(at + 2);
    at += 4;

    const fields = [];
    for (let i = 0; i < fieldCount && at + 4 <= end; i++) {
      let type = buf.readUInt16BE(at);
      const length = buf.readUInt16BE(at + 2);
      at += 4;
      // IPFIX enterprise-specific elements set the top bit and append a
      // four-byte PEN. We do not act on vendor elements, but their bytes
      // must still be accounted for or every field after them misaligns.
      if (type & 0x8000) { at += 4; type = 0; }
      fields.push({ type, length });
    }
    if (!fields.length) break;
    store.set(`${key}:${templateId}`, { fields, at: Date.now() });
    learned++;
  }
  return learned;
}

export function decodeNetflowV9(buf, templates, exporter) {
  const count = buf.readUInt16BE(2);
  const sourceId = buf.readUInt32BE(16);
  const key = `${exporter}:v9:${sourceId}`;
  const records = [];
  let pending = 0;
  let learned = 0;
  let at = 20;

  // `count` is a count of records across all sets, not of sets, so the
  // datagram length is what actually bounds the walk.
  while (at + 4 <= buf.length) {
    const setId = buf.readUInt16BE(at);
    const setLength = buf.readUInt16BE(at + 2);
    if (setLength < 4 || at + setLength > buf.length) break;
    const body = at + 4;
    const end = at + setLength;

    if (setId === 0) learned += readTemplateSet(buf, body, end, templates, key);
    else if (setId === 1) { /* options templates describe metadata, not flows */ }
    else if (setId > 255) {
      const template = templates.get(`${key}:${setId}`);
      if (template) records.push(...decodeDataSet(buf, body, end, template));
      else pending++;                    // the template has not arrived yet
    }
    at = end;
  }
  void count;
  return { version: 9, records, pending, templatesLearned: learned };
}

export function decodeIpfix(buf, templates, exporter) {
  const length = buf.readUInt16BE(2);
  const domain = buf.readUInt32BE(12);
  const key = `${exporter}:ipfix:${domain}`;
  const limit = Math.min(length, buf.length);
  const records = [];
  let pending = 0;
  let learned = 0;
  let at = 16;

  while (at + 4 <= limit) {
    const setId = buf.readUInt16BE(at);
    const setLength = buf.readUInt16BE(at + 2);
    if (setLength < 4 || at + setLength > limit) break;
    const body = at + 4;
    const end = at + setLength;

    if (setId === 2) learned += readTemplateSet(buf, body, end, templates, key);
    else if (setId === 3) { /* options templates */ }
    else if (setId >= 256) {
      const template = templates.get(`${key}:${setId}`);
      if (template) records.push(...decodeDataSet(buf, body, end, template));
      else pending++;
    }
    at = end;
  }
  return { version: 10, records, pending, templatesLearned: learned };
}

/* ── sFlow v5 ───────────────────────────────────────────────────────────
   A different animal: rather than a summarised flow, sFlow ships the first
   bytes of sampled packets. So the addresses come out of a real Ethernet
   frame, and the byte count is the sampled frame length multiplied by the
   sampling rate the agent reports. */

const SFLOW_FLOW_SAMPLE = 1;
const SFLOW_FLOW_SAMPLE_EXPANDED = 3;
const SFLOW_RAW_PACKET = 1;

/** Pull addresses and ports out of a sampled Ethernet frame. */
export function decodeEthernet(buf, at, end) {
  if (at + 14 > end) return null;
  let etherType = buf.readUInt16BE(at + 12);
  let ip = at + 14;
  // Up to two VLAN tags; QinQ is common enough on a trunk to matter.
  for (let i = 0; i < 2 && (etherType === 0x8100 || etherType === 0x88a8); i++) {
    if (ip + 4 > end) return null;
    etherType = buf.readUInt16BE(ip + 2);
    ip += 4;
  }

  const record = blankRecord();
  if (etherType === 0x0800) {                      // IPv4
    if (ip + 20 > end) return null;
    const ihl = (buf[ip] & 0x0f) * 4;
    if (ihl < 20) return null;
    record.protocol = buf[ip + 9];
    record.tos = buf[ip + 1];
    record.srcAddr = ipv4(buf, ip + 12);
    record.dstAddr = ipv4(buf, ip + 16);
    const l4 = ip + ihl;
    if ((record.protocol === 6 || record.protocol === 17) && l4 + 4 <= end) {
      record.srcPort = buf.readUInt16BE(l4);
      record.dstPort = buf.readUInt16BE(l4 + 2);
    }
    if (record.protocol === 6 && l4 + 14 <= end) record.tcpFlags = buf[l4 + 13];
    return record;
  }
  if (etherType === 0x86dd) {                      // IPv6
    if (ip + 40 > end) return null;
    record.protocol = buf[ip + 6];                 // next header, not chased
    record.srcAddr = ipv6(buf, ip + 8);
    record.dstAddr = ipv6(buf, ip + 24);
    const l4 = ip + 40;
    if ((record.protocol === 6 || record.protocol === 17) && l4 + 4 <= end) {
      record.srcPort = buf.readUInt16BE(l4);
      record.dstPort = buf.readUInt16BE(l4 + 2);
    }
    return record;
  }
  return null;                                     // ARP, LLDP, MPLS — not a flow
}

export function decodeSflow(buf) {
  const agentType = buf.readUInt32BE(4);
  let at = 8 + (agentType === 2 ? 16 : 4);         // 1 = IPv4 agent, 2 = IPv6
  at += 4;                                         // sub-agent id
  at += 4;                                         // datagram sequence
  at += 4;                                         // uptime
  if (at + 4 > buf.length) return { version: 5, records: [], pending: 0 };
  const sampleCount = buf.readUInt32BE(at);
  at += 4;

  const records = [];
  for (let s = 0; s < sampleCount && at + 8 <= buf.length; s++) {
    const format = buf.readUInt32BE(at) & 0xfff;   // low 12 bits when enterprise-tagged
    const sampleLength = buf.readUInt32BE(at + 4);
    const sampleEnd = at + 8 + sampleLength;
    if (sampleEnd > buf.length) break;
    let p = at + 8;

    if (format === SFLOW_FLOW_SAMPLE || format === SFLOW_FLOW_SAMPLE_EXPANDED) {
      // The two shapes differ only in how the data source and the two
      // interfaces are encoded: packed into one word each in the original,
      // split into a format/value pair in the expanded form.
      const expanded = format === SFLOW_FLOW_SAMPLE_EXPANDED;
      const header = expanded ? 44 : 32;
      if (p + header > sampleEnd) { at = sampleEnd; continue; }

      p += 4;                                      // sample sequence number
      p += expanded ? 8 : 4;                       // data source
      const rate = buf.readUInt32BE(p); p += 4;    // sampling rate
      p += 4;                                      // sample pool
      p += 4;                                      // drops
      // Expanded interfaces are (format, value); the value is the ifIndex.
      const inputIf = expanded ? buf.readUInt32BE(p + 4) : buf.readUInt32BE(p);
      p += expanded ? 8 : 4;
      const outputIf = expanded ? buf.readUInt32BE(p + 4) : buf.readUInt32BE(p);
      p += expanded ? 8 : 4;
      const recordCount = buf.readUInt32BE(p); p += 4;

      for (let r = 0; r < recordCount && p + 8 <= sampleEnd; r++) {
        const recFormat = buf.readUInt32BE(p) & 0xfff;
        const recLength = buf.readUInt32BE(p + 4);
        const recEnd = p + 8 + recLength;
        if (recEnd > sampleEnd) break;

        if (recFormat === SFLOW_RAW_PACKET && p + 8 + 16 <= sampleEnd) {
          const frameLength = buf.readUInt32BE(p + 8 + 4);
          const headerBytes = buf.readUInt32BE(p + 8 + 12);
          const headerAt = p + 8 + 16;
          const decoded = decodeEthernet(buf, headerAt,
            Math.min(headerAt + headerBytes, recEnd));
          if (decoded) {
            // The sample stands for `rate` packets; reporting the sampled
            // byte count alone under-reports a 1-in-1000 sampler by three
            // orders of magnitude and makes the whole view useless.
            const scale = rate > 0 ? rate : 1;
            decoded.bytes = frameLength * scale;
            decoded.packets = scale;
            decoded.inputIf = inputIf;
            decoded.outputIf = outputIf;
            decoded.sampled = true;
            records.push(decoded);
          }
        }
        p = recEnd;
      }
    }
    at = sampleEnd;
  }
  return { version: 5, records, pending: 0 };
}

/* ── the one entry point ────────────────────────────────────────────── */

/**
 * Decode any supported flow datagram.
 *
 * @param {Buffer} buf          the datagram
 * @param {Map} templates       v9/IPFIX template cache, per collector
 * @param {string} exporter     source address — templates are scoped to it
 * @returns {{version:number, records:object[], pending:number,
 *            templatesLearned?:number}|null}  null when it is not flow at all
 */
export function decodeFlowPacket(buf, templates, exporter) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  const version = buf.readUInt16BE(0);
  try {
    if (version === 5) return decodeNetflowV5(buf);
    if (version === 9) return decodeNetflowV9(buf, templates, exporter);
    if (version === 10) return decodeIpfix(buf, templates, exporter);
    // sFlow's first four bytes are the version as a 32-bit word, so a v5
    // sFlow datagram reads as 0 in the first 16 bits.
    if (version === 0 && buf.readUInt32BE(0) === 5) return decodeSflow(buf);
  } catch {
    // A malformed datagram is a fact about the sender, not a reason for the
    // collector to stop; the caller counts these.
    return null;
  }
  return null;
}

/**
 * The key a flow record aggregates under.
 *
 * This is the single most consequential decision in the flow pipeline.
 * Per-conversation records at line rate are orders of magnitude above what
 * the write path can take, so records are folded at ingest — and the key
 * decides what question the stored data can still answer. Direction is
 * normalised (a conversation is one thing seen from both ends) and ephemeral
 * client ports are dropped, because "10.0.0.5:54321" is not an entity anyone
 * wants a row for.
 */
export function aggregationKey(record) {
  const service = serviceName(record.protocol, record.srcPort, record.dstPort);
  // Order the endpoints so A→B and B→A fold together.
  const [a, b] = record.srcAddr <= record.dstAddr
    ? [record.srcAddr, record.dstAddr]
    : [record.dstAddr, record.srcAddr];
  return `${a}|${b}|${record.protocol}|${service}|${record.inputIf}`;
}
