/**
 * Syslog grammar. Real devices are not RFC-shaped, so most of these cases
 * come from what switches, firewalls and BSD daemons actually put on the
 * wire rather than from the RFCs' happy paths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSyslog, decodePriority, SYSLOG_FACILITY, SYSLOG_SEVERITY }
  from '@watcher/shared/syslog';
import { frameTcp } from '../src/receivers/syslog.js';

test('priority decodes into facility and severity', () => {
  assert.deepEqual(decodePriority(0), { facility: 0, severity: 0 });
  assert.deepEqual(decodePriority(34), { facility: 4, severity: 2 });   // auth.crit
  assert.deepEqual(decodePriority(191), { facility: 23, severity: 7 }); // local7.debug
});

test('priority outside the legal range is refused rather than invented', () => {
  assert.equal(decodePriority(192), null);
  assert.equal(decodePriority(-1), null);
  assert.equal(decodePriority(1.5), null);
  assert.equal(decodePriority('34'), null);
});

test('RFC 5424 message parses into all of its fields', () => {
  const line = '<34>1 2026-09-08T22:14:15.003Z mymachine.example.com su 1234 ID47 '
    + '[exampleSDID@32473 iut="3" eventSource="Application"] Failed password for root';
  const r = parseSyslog(line);
  assert.equal(r.format, 'rfc5424');
  assert.equal(r.facility, 4);
  assert.equal(r.severity, 2);
  assert.equal(r.facilityName, 'auth');
  assert.equal(r.severityName, 'crit');
  assert.equal(r.hostname, 'mymachine.example.com');
  assert.equal(r.appName, 'su');
  assert.equal(r.procId, '1234');
  assert.equal(r.msgId, 'ID47');
  assert.equal(r.structuredData, '[exampleSDID@32473 iut="3" eventSource="Application"]');
  assert.equal(r.message, 'Failed password for root');
  assert.equal(r.timestamp.toISOString(), '2026-09-08T22:14:15.003Z');
});

test("RFC 5424 nil values ('-') come back empty, not as a dash", () => {
  const r = parseSyslog('<165>1 2026-09-08T22:14:15Z host - - - - the message');
  assert.equal(r.appName, '');
  assert.equal(r.procId, '');
  assert.equal(r.msgId, '');
  assert.equal(r.structuredData, '');
  assert.equal(r.message, 'the message');
});

test('structured data containing an escaped bracket does not end the element early', () => {
  const line = '<34>1 2026-09-08T22:14:15Z h a - - [ex@1 note="a \\] b"] real message';
  const r = parseSyslog(line);
  assert.equal(r.structuredData, '[ex@1 note="a \\] b"]');
  assert.equal(r.message, 'real message');
});

test('multiple structured-data elements stay together', () => {
  const r = parseSyslog('<34>1 2026-09-08T22:14:15Z h a - - [a@1 x="1"][b@2 y="2"] msg');
  assert.equal(r.structuredData, '[a@1 x="1"][b@2 y="2"]');
  assert.equal(r.message, 'msg');
});

test('a UTF-8 BOM introduces the message and is not part of it', () => {
  const r = parseSyslog('<34>1 2026-09-08T22:14:15Z h a - - - ﻿hello');
  assert.equal(r.message, 'hello');
});

test('RFC 3164 with a bracketed pid', () => {
  const r = parseSyslog('<34>Oct 11 22:14:15 mymachine su[1234]: root login failed',
    { now: new Date('2026-10-12T00:00:00Z') });
  assert.equal(r.format, 'rfc3164');
  assert.equal(r.hostname, 'mymachine');
  assert.equal(r.appName, 'su');
  assert.equal(r.procId, '1234');
  assert.equal(r.message, 'root login failed');
  assert.equal(r.timestamp.toISOString(), '2026-10-11T22:14:15.000Z');
});

test('RFC 3164 single-digit day is space padded', () => {
  const r = parseSyslog('<13>Oct  1 09:05:00 host app: text',
    { now: new Date('2026-10-02T00:00:00Z') });
  assert.equal(r.format, 'rfc3164');
  assert.equal(r.timestamp.toISOString(), '2026-10-01T09:05:00.000Z');
  assert.equal(r.appName, 'app');
  assert.equal(r.message, 'text');
});

test('RFC 3164 without a pid still separates tag from message', () => {
  const r = parseSyslog('<190>Sep  8 22:14:15 sw1 %LINK-3-UPDOWN: Interface Gi0/1, changed state to down',
    { now: new Date('2026-09-08T23:00:00Z') });
  assert.equal(r.hostname, 'sw1');
  // A Cisco facility tag is not a bare word; what matters is that the
  // message survives intact for a rule to match on.
  assert.match(r.message, /Interface Gi0\/1, changed state to down/);
});

test('a December stamp read in January is last year, not next year', () => {
  const r = parseSyslog('<13>Dec 31 23:59:00 host app: rollover',
    { now: new Date('2027-01-01T00:05:00Z') });
  assert.equal(r.timestamp.getUTCFullYear(), 2026);
});

test('a stamp a few hours ahead of now keeps the current year', () => {
  const r = parseSyslog('<13>Sep  8 23:00:00 host app: clock skew',
    { now: new Date('2026-09-08T22:00:00Z') });
  assert.equal(r.timestamp.getUTCFullYear(), 2026);
});

test('a line with no priority is kept whole rather than dropped', () => {
  const r = parseSyslog('this device does not speak syslog properly');
  assert.equal(r.format, 'raw');
  assert.equal(r.facility, null);
  assert.equal(r.message, 'this device does not speak syslog properly');
});

test('a priority we understand on a line we do not keeps the decoded halves', () => {
  const r = parseSyslog('<34>something entirely non-standard');
  assert.equal(r.format, 'raw');
  assert.equal(r.facility, 4);
  assert.equal(r.severityName, 'crit');
  assert.equal(r.message, 'something entirely non-standard');
});

test('trailing newline and NUL padding are stripped', () => {
  const r = parseSyslog(Buffer.from('<13>Sep  8 22:14:15 h a: text\n\0\0', 'utf8'),
    { now: new Date('2026-09-08T23:00:00Z') });
  assert.equal(r.message, 'text');
});

test('facility and severity name tables are the RFC ones', () => {
  assert.equal(SYSLOG_FACILITY[0], 'kern');
  assert.equal(SYSLOG_FACILITY[23], 'local7');
  assert.equal(SYSLOG_SEVERITY[0], 'emerg');
  assert.equal(SYSLOG_SEVERITY[7], 'debug');
});

/* ── TCP framing (RFC 6587) ───────────────────────────────────────────── */

test('newline framing splits a stream into messages', () => {
  const { messages, rest } = frameTcp(Buffer.from('<13>one\n<13>two\n'));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].toString(), '<13>one');
  assert.equal(messages[1].toString(), '<13>two');
  assert.equal(rest.length, 0);
});

test('octet counting framing reads exactly the stated length', () => {
  const body = '<13>hello world';
  const { messages, rest } = frameTcp(Buffer.from(`${body.length} ${body}`));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].toString(), body);
  assert.equal(rest.length, 0);
});

test('a message split across two TCP segments is not lost', () => {
  const first = frameTcp(Buffer.from('<13>par'));
  assert.equal(first.messages.length, 0);
  const second = frameTcp(Buffer.concat([first.rest, Buffer.from('tial\n')]));
  assert.equal(second.messages.length, 1);
  assert.equal(second.messages[0].toString(), '<13>partial');
});

test('an octet-counted message split across segments waits for the remainder', () => {
  const body = '<13>abcdefghij';
  const whole = Buffer.from(`${body.length} ${body}`);
  const a = frameTcp(whole.subarray(0, 10));
  assert.equal(a.messages.length, 0);
  const b = frameTcp(Buffer.concat([a.rest, whole.subarray(10)]));
  assert.equal(b.messages.length, 1);
  assert.equal(b.messages[0].toString(), body);
});

test('empty lines between messages are skipped, not emitted', () => {
  const { messages } = frameTcp(Buffer.from('<13>one\n\n<13>two\n'));
  assert.equal(messages.length, 2);
});

test('a length prefix that is not a number is read as newline framing', () => {
  const { messages } = frameTcp(Buffer.from('<13>12 not a length\n'));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].toString(), '<13>12 not a length');
});
