/**
 * SNMP trap receiver — v1, v2c and v3, plus informs.
 *
 * Polling asks "what is true now?" on a schedule. Between two polls a port
 * can go down and come back, a redundant PSU can fail over, a BGP session
 * can reset — and a poller sees none of it, because by the time it looks the
 * device is telling the truth again. That gap is why every serious NMS
 * receives traps, and closing it is what this file is for.
 *
 * Three things here are easy to get wrong and are therefore done explicitly:
 *
 *  · v1 traps carry a completely different identity (enterprise OID plus
 *    generic and specific numbers) from v2c/v3 (a single snmpTrapOID
 *    varbind). RFC 3584 §3.1 defines how to translate one into the other,
 *    and doing that here means a rule set is written once, against OIDs,
 *    rather than twice.
 *  · informs must be acknowledged or the sender retransmits until it gives
 *    up — net-snmp answers them for us, which is why they are handled by
 *    the same receiver rather than a second listener.
 *  · v3 authentication needs users registered before a trap arrives, and an
 *    unregistered user is dropped silently by the library. It is logged here
 *    instead, because "we configured v3 and nothing appeared" is otherwise
 *    an afternoon of packet captures.
 */
import snmp from 'net-snmp';
import { EVENT_SOURCE } from '@watcher/shared';

/** sysUpTime.0 and snmpTrapOID.0 lead every v2c/v3 trap; they are not payload. */
const SYS_UPTIME_OID = '1.3.6.1.2.1.1.3.0';
const TRAP_OID_OID = '1.3.6.1.6.3.1.1.4.1.0';
/** snmpTraps prefix — the standard traps live at .1 … .6 (RFC 3418). */
const SNMP_TRAPS = '1.3.6.1.6.3.1.1.5';

/**
 * Translate a v1 trap's identity into the v2c trap OID it corresponds to,
 * per RFC 3584 §3.1:
 *
 *   generic 0..5  → snmpTraps.(generic + 1)
 *   generic 6     → enterprise + ".0." + specific
 *
 * Exported because it is the one piece of this file worth testing on its own.
 */
export function v1TrapOid(enterprise, generic, specific) {
  if (generic >= 0 && generic <= 5) return `${SNMP_TRAPS}.${generic + 1}`;
  const base = String(enterprise ?? '').replace(/\.$/, '');
  return `${base}.0.${specific}`;
}

/**
 * Render a varbind value as something a rule's regex can match and a person
 * can read. Buffers are the interesting case: an OCTET STRING is text about
 * as often as it is a MAC address, so printable bytes are shown as text and
 * everything else as hex.
 */
export function renderValue(value) {
  if (value === null || value === undefined) return '';
  if (Buffer.isBuffer(value)) {
    const printable = value.every((b) => b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b < 0x7f));
    return printable ? value.toString('utf8') : value.toString('hex').replace(/(..)(?=.)/g, '$1:');
  }
  if (Array.isArray(value)) return value.join('.');
  return String(value);
}

/**
 * Turn a received PDU into the varbind list, the trap OID, and a one-line
 * message. The message is what rules match and what the alert carries, so it
 * has to be both stable enough to write a regex against and readable enough
 * to page someone with.
 */
export function decodeTrap(pdu) {
  const varbinds = [];
  let oid = '';

  if (pdu.type === snmp.PduType.Trap) {
    // v1: identity is in the PDU header, not the varbinds.
    oid = v1TrapOid(pdu.enterprise, pdu.generic, pdu.specific);
    for (const vb of pdu.varbinds ?? []) {
      varbinds.push({ oid: vb.oid, value: renderValue(vb.value) });
    }
  } else {
    for (const vb of pdu.varbinds ?? []) {
      if (vb.oid === SYS_UPTIME_OID) continue;
      if (vb.oid === TRAP_OID_OID) { oid = renderValue(vb.value); continue; }
      varbinds.push({ oid: vb.oid, value: renderValue(vb.value) });
    }
  }

  const message = varbinds.length
    ? varbinds.map((v) => `${v.oid}=${v.value}`).join(' ')
    : `trap ${oid}`;

  return { oid, varbinds, message };
}

export class TrapReceiver {
  /**
   * @param {object} opts
   * @param {number} [opts.port=162]
   * @param {string[]} [opts.communities]  v1/v2c communities to accept
   * @param {object[]} [opts.users]        v3 users {name, level, authProtocol, authKey, privProtocol, privKey}
   * @param {object} deps {pipeline, log}
   */
  constructor(opts, { pipeline, log }) {
    this.port = Number(opts.port ?? 162);
    this.communities = opts.communities ?? [];
    this.users = opts.users ?? [];
    this.pipeline = pipeline;
    this.log = log;
    this.receiver = null;
    this.rejected = 0;
  }

  start() {
    this.receiver = snmp.createReceiver({
      port: this.port,
      transport: 'udp4',
      // Authorisation stays ON. A receiver that accepts any community is an
      // open alert-injection port, and the allow-list downstream is a second
      // line of defence, not a replacement for this one.
      disableAuthorization: false,
      includeAuthentication: true,
    }, (error, data) => {
      if (error) {
        // Wrong community, unknown v3 user, malformed packet. Counted and
        // sampled rather than logged per packet: a scanner should not be
        // able to fill the disk through the log.
        if (this.rejected++ % 100 === 0) {
          this.log.warn({ err: String(error?.message ?? error), rejected: this.rejected },
            'SNMP trap rejected');
        }
        return;
      }
      this.#onTrap(data).catch((err) => this.log.error({ err }, 'trap handling failed'));
    });

    const auth = this.receiver.getAuthorizer();
    for (const community of this.communities) auth.addCommunity(community);
    for (const user of this.users) {
      auth.addUser({
        name: user.name,
        level: snmp.SecurityLevel[user.level] ?? snmp.SecurityLevel.authPriv,
        authProtocol: snmp.AuthProtocols[user.authProtocol] ?? snmp.AuthProtocols.sha,
        authKey: user.authKey,
        privProtocol: snmp.PrivProtocols[user.privProtocol] ?? snmp.PrivProtocols.aes,
        privKey: user.privKey,
      });
    }

    this.log.info(
      { port: this.port, communities: this.communities.length, v3users: this.users.length },
      'SNMP trap receiver listening');
    if (!this.communities.length && !this.users.length) {
      this.log.warn('no trap communities or v3 users configured — every trap will be rejected');
    }
  }

  async #onTrap(data) {
    const address = String(data.rinfo?.address ?? '').replace(/^::ffff:/, '');
    const { oid, varbinds, message } = decodeTrap(data.pdu);

    await this.pipeline.handle({
      source: EVENT_SOURCE.TRAP,
      sourceIp: address,
      timestamp: new Date(),
      oid,
      facility: null,
      severity: null,
      facilityName: '',
      severityName: '',
      appName: '',
      message,
      detail: {
        varbinds,
        version: data.pdu.type === snmp.PduType.Trap ? 'v1' : 'v2c/v3',
        inform: data.pdu.type === snmp.PduType.InformRequest,
        community: data.pdu.community,
        user: data.pdu.user,
      },
    });
  }

  stop() {
    if (this.receiver) this.receiver.close();
    this.receiver = null;
  }

  stats() { return { rejected: this.rejected }; }
}
