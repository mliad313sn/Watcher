/**
 * Syslog wire-format parsing — RFC 3164 (BSD) and RFC 5424.
 *
 * Both formats begin with the same priority value, so one parser can take
 * either: `<PRI>` decodes to facility and severity, and what follows tells
 * us which RFC we are reading. A message that matches neither grammar is
 * still returned — with `format: 'raw'` and the whole line as the message —
 * because a device that logs badly is exactly the device you want to hear
 * from, and dropping it would make the receiver lie by omission.
 *
 * Pure functions, no I/O: the receivers own the sockets, this owns the
 * grammar, and the tests can therefore cover the grammar exhaustively.
 */

/** Syslog facilities, by numeric code (RFC 5424 §6.2.1). */
export const SYSLOG_FACILITY = Object.freeze([
  'kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news',
  'uucp', 'cron', 'authpriv', 'ftp', 'ntp', 'audit', 'alert', 'clock',
  'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7',
]);

/** Syslog severities, by numeric code — 0 is worst. */
export const SYSLOG_SEVERITY = Object.freeze([
  'emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug',
]);

/** The highest legal priority value: facility 23, severity 7. */
const MAX_PRI = 191;

const RFC3164_TS = /^([A-Z][a-z]{2}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Decode a priority value into its facility and severity halves.
 * Returns null for anything outside the legal range rather than inventing
 * a facility 24 that no receiver downstream knows how to name.
 */
export function decodePriority(pri) {
  if (!Number.isInteger(pri) || pri < 0 || pri > MAX_PRI) return null;
  return { facility: pri >> 3, severity: pri & 7 };
}

/**
 * RFC 3164 stamps carry no year. Choosing the current one is wrong for
 * about a day each January, and wrong in the direction that puts a message
 * a year in the future — so a stamp more than a day ahead of now is read
 * as last year instead.
 */
function resolve3164Timestamp(month, day, hh, mm, ss, now) {
  const year = now.getUTCFullYear();
  const at = Date.UTC(year, month, day, hh, mm, ss);
  if (at - now.getTime() > 86_400_000) return new Date(Date.UTC(year - 1, month, day, hh, mm, ss));
  return new Date(at);
}

/** RFC 5424 permits '-' for any field that has no value. */
function nilable(value) {
  return value === '-' || value === undefined ? '' : value;
}

/**
 * Split an RFC 5424 line after its structured-data element, which is the
 * only field that can legally contain spaces. `]` inside a param value is
 * escaped as `\]`, so a naive indexOf would end the element early.
 */
function splitStructuredData(rest) {
  if (rest.startsWith('-')) return { sd: '', msg: rest.slice(1).replace(/^ /, '') };
  if (!rest.startsWith('[')) return { sd: '', msg: rest };

  // SD is a sequence of elements written with no separator between them
  // ("[a@1 x=\"1\"][b@2 y=\"2\"]"), and the message begins after the space
  // that follows the last one. So each element is consumed in turn, and the
  // scan stops at the first character that does not open another.
  let at = 0;
  while (at < rest.length && rest[at] === '[') {
    let depth = 0;
    let closed = -1;
    for (let i = at; i < rest.length; i++) {
      const c = rest[i];
      if (c === '\\') { i++; continue; }
      if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) { closed = i; break; }
      }
    }
    if (closed === -1) return { sd: rest, msg: '' };   // unterminated — keep it, do not guess
    at = closed + 1;
  }
  return { sd: rest.slice(0, at), msg: rest.slice(at).replace(/^ /, '') };
}

/**
 * Parse one syslog line.
 *
 * @param {string|Buffer} input  a single message, without framing
 * @param {{now?: Date}} [opts]  injection point for the RFC 3164 year rule
 * @returns {{
 *   format: 'rfc5424'|'rfc3164'|'raw',
 *   facility: number|null, severity: number|null,
 *   facilityName: string, severityName: string,
 *   timestamp: Date, hostname: string, appName: string,
 *   procId: string, msgId: string, structuredData: string, message: string,
 * }}
 */
export function parseSyslog(input, opts = {}) {
  const now = opts.now ?? new Date();
  const line = (Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? ''))
    .replace(/\0+$/, '')                   // some stacks pad the datagram
    .replace(/\r?\n$/, '');

  const base = {
    format: 'raw', facility: null, severity: null,
    facilityName: '', severityName: '',
    timestamp: now, hostname: '', appName: '', procId: '', msgId: '',
    structuredData: '', message: line,
  };

  const pri = /^<(\d{1,3})>/.exec(line);
  if (!pri) return base;
  const decoded = decodePriority(Number(pri[1]));
  if (!decoded) return base;

  const named = {
    ...base,
    facility: decoded.facility,
    severity: decoded.severity,
    facilityName: SYSLOG_FACILITY[decoded.facility] ?? String(decoded.facility),
    severityName: SYSLOG_SEVERITY[decoded.severity] ?? String(decoded.severity),
  };
  const rest = line.slice(pri[0].length);

  // RFC 5424 announces itself with a version number, always 1 today.
  const v5 = /^1 (\S+) (\S+) (\S+) (\S+) (\S+) ?/.exec(rest);
  if (v5) {
    const stamp = new Date(v5[1]);
    const { sd, msg } = splitStructuredData(rest.slice(v5[0].length));
    return {
      ...named,
      format: 'rfc5424',
      timestamp: Number.isNaN(stamp.getTime()) ? now : stamp,
      hostname: nilable(v5[2]),
      appName: nilable(v5[3]),
      procId: nilable(v5[4]),
      msgId: nilable(v5[5]),
      structuredData: sd,
      // A BOM introduces a UTF-8 MSG (RFC 5424 §6.4) and is not content.
      message: msg.replace(/^﻿/, ''),
    };
  }

  // RFC 3164: "MMM dd hh:mm:ss HOSTNAME TAG[pid]: message".
  const ts = RFC3164_TS.exec(rest.slice(0, 15));
  if (ts) {
    const month = MONTHS.indexOf(ts[1]);
    const after = rest.slice(15).replace(/^ /, '');
    const sp = after.indexOf(' ');
    const hostname = sp === -1 ? after : after.slice(0, sp);
    const body = sp === -1 ? '' : after.slice(sp + 1);
    // The tag ends at the first non-alphanumeric character; a bracketed
    // process id and the colon that follows are separators, not content.
    const tag = /^([\w.\-/]{1,48})(?:\[(\d{1,10})\])?:?\s?/.exec(body);
    return {
      ...named,
      format: 'rfc3164',
      timestamp: month === -1
        ? now
        : resolve3164Timestamp(month, Number(ts[2]), Number(ts[3]), Number(ts[4]), Number(ts[5]), now),
      hostname,
      appName: tag ? tag[1] : '',
      procId: tag && tag[2] ? tag[2] : '',
      message: tag ? body.slice(tag[0].length) : body,
    };
  }

  // A priority we understood on a line we did not: keep the decoded halves
  // and hand the remainder over as the message.
  return { ...named, message: rest };
}
