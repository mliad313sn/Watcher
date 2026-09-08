/**
 * The rule engine decides who gets woken up at 3am, so it gets the most
 * adversarial tests in the codebase: OID prefixes that must not collide,
 * severity comparisons that run backwards, and templates that decide whether
 * a thousand traps are one alert or a thousand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  oidMatches, ruleMatches, evaluateEvent, expandTemplate, compilePattern,
  defaultCheckName, severityToServiceState, syslogSeverityHint,
  RULE_ACTION, EVENT_SOURCE, MAX_PATTERN_LENGTH,
} from '@watcher/shared/events';
import { SEVERITY, SERVICE_STATE } from '@watcher/shared';
import { v1TrapOid, renderValue, decodeTrap } from '../src/receivers/traps.js';
import { RateLimiter } from '../src/receivers/pipeline.js';

const trap = (over = {}) => ({
  source: EVENT_SOURCE.TRAP, oid: '1.3.6.1.6.3.1.1.5.3',
  message: 'ifIndex=7 ifDescr=Gi0/1', deviceName: 'sw1', ...over,
});
const syslog = (over = {}) => ({
  source: EVENT_SOURCE.SYSLOG, oid: '', facility: 4, severity: 3,
  facilityName: 'auth', severityName: 'err', appName: 'sshd',
  message: 'Failed password for root from 10.0.0.9', deviceName: 'fw1', ...over,
});

/* ── OID selection ─────────────────────────────────────────────────────── */

test('an OID selector matches itself and anything beneath it', () => {
  assert.equal(oidMatches('1.3.6.1.4.1.9', '1.3.6.1.4.1.9'), true);
  assert.equal(oidMatches('1.3.6.1.4.1.9', '1.3.6.1.4.1.9.1.1'), true);
});

test('an OID selector does not match a longer sibling arc', () => {
  // The bug this exists to prevent: Cisco (9) selecting Juniper-adjacent
  // vendor 99 through a bare startsWith, and paging the wrong team.
  assert.equal(oidMatches('1.3.6.1.4.1.9', '1.3.6.1.4.1.99'), false);
  assert.equal(oidMatches('1.3.6.1.4.1.9', '1.3.6.1.4.1.911.2'), false);
});

test('an empty selector matches everything and a missing OID matches nothing', () => {
  assert.equal(oidMatches('', '1.2.3'), true);
  assert.equal(oidMatches('1.2', ''), false);
  assert.equal(oidMatches('1.2', undefined), false);
});

test('leading and trailing dots in a selector are tolerated', () => {
  assert.equal(oidMatches('.1.3.6.1.6.3.1.1.5.3', '1.3.6.1.6.3.1.1.5.3'), true);
  assert.equal(oidMatches('1.3.6.1.4.1.9.', '.1.3.6.1.4.1.9.1'), true);
});

/* ── rule matching ─────────────────────────────────────────────────────── */

test('a disabled rule never matches', () => {
  assert.equal(ruleMatches({ enabled: false }, trap()), false);
});

test('a rule bound to one source ignores the other', () => {
  assert.equal(ruleMatches({ source: 'syslog' }, trap()), false);
  assert.equal(ruleMatches({ source: 'trap' }, trap()), true);
  assert.equal(ruleMatches({ source: 'any' }, trap()), true);
});

test('syslog severity is compared the way an operator says it', () => {
  // maxSeverity 3 means "err and worse", and severity counts DOWN.
  assert.equal(ruleMatches({ maxSeverity: 3 }, syslog({ severity: 3 })), true);
  assert.equal(ruleMatches({ maxSeverity: 3 }, syslog({ severity: 0 })), true);
  assert.equal(ruleMatches({ maxSeverity: 3 }, syslog({ severity: 4 })), false);
});

test('a severity selector cannot match an event that has no severity', () => {
  assert.equal(ruleMatches({ maxSeverity: 7 }, trap()), false);
});

test('every selector that is set must match', () => {
  const rule = { source: 'syslog', matchApp: 'sshd', maxSeverity: 3, matchPattern: 'failed password' };
  assert.equal(ruleMatches(rule, syslog()), true);
  assert.equal(ruleMatches(rule, syslog({ appName: 'cron' })), false);
  assert.equal(ruleMatches(rule, syslog({ severity: 6 })), false);
  assert.equal(ruleMatches(rule, syslog({ message: 'accepted password' })), false);
});

test('facility 0 is a real selector and not treated as absent', () => {
  // kern is facility 0; a `if (rule.matchFacility)` bug makes this rule
  // match every event instead of only kernel ones.
  const rule = { matchFacility: 0 };
  assert.equal(ruleMatches(rule, syslog({ facility: 0 })), true);
  assert.equal(ruleMatches(rule, syslog({ facility: 4 })), false);
});

test('severity 0 is a real selector and not treated as absent', () => {
  assert.equal(ruleMatches({ maxSeverity: 0 }, syslog({ severity: 0 })), true);
  assert.equal(ruleMatches({ maxSeverity: 0 }, syslog({ severity: 1 })), false);
});

test('patterns are case-insensitive', () => {
  assert.equal(ruleMatches({ matchPattern: 'FAILED PASSWORD' }, syslog()), true);
});

/* ── refused patterns ──────────────────────────────────────────────────── */

test('an invalid pattern is refused and matches nothing rather than throwing', () => {
  assert.equal(compilePattern('([unclosed'), null);
  assert.equal(ruleMatches({ matchPattern: '([unclosed' }, syslog()), false);
});

test('an over-long pattern is refused', () => {
  const long = 'a'.repeat(MAX_PATTERN_LENGTH + 1);
  assert.equal(compilePattern(long), null);
  assert.equal(ruleMatches({ matchPattern: long }, syslog()), false);
});

test('an empty pattern is not a selector at all', () => {
  assert.equal(compilePattern(''), null);
  assert.equal(ruleMatches({ matchPattern: '' }, syslog()), true);
});

/* ── templates ─────────────────────────────────────────────────────────── */

test('a template expands event fields', () => {
  assert.equal(expandTemplate('{host} {app} {severity}', syslog()), 'fw1 sshd err');
  assert.equal(expandTemplate('trap {oid}', trap()), 'trap 1.3.6.1.6.3.1.1.5.3');
});

test('a template expands capture groups from the rule pattern', () => {
  const captures = ['Gi0/1 down', 'Gi0/1'];
  assert.equal(expandTemplate('link {1}', trap(), captures), 'link Gi0/1');
});

test('an unknown placeholder is left alone rather than blanked', () => {
  assert.equal(expandTemplate('{nope} x', syslog()), '{nope} x');
});

test('a missing capture group renders empty and the name still trims', () => {
  assert.equal(expandTemplate('link {3}', trap(), ['whole']), 'link');
});

/* ── evaluation ────────────────────────────────────────────────────────── */

test('the lowest priority number wins, not the first row in the array', () => {
  const rules = [
    { id: 'b', priority: 50, action: 'alert', severity: 'warning', checkName: 'late' },
    { id: 'a', priority: 10, action: 'alert', severity: 'critical', checkName: 'early' },
  ];
  const d = evaluateEvent(rules, trap());
  assert.equal(d.checkName, 'early');
  assert.equal(d.severity, 'critical');
});

test('ties break deterministically by id so two runs agree', () => {
  const rules = [
    { id: 'zz', priority: 10, checkName: 'z' },
    { id: 'aa', priority: 10, checkName: 'a' },
  ];
  assert.equal(evaluateEvent(rules, trap()).checkName, 'a');
  assert.equal(evaluateEvent([...rules].reverse(), trap()).checkName, 'a');
});

test('an event no rule claims is logged, never raised', () => {
  const d = evaluateEvent([], syslog());
  assert.equal(d.action, RULE_ACTION.LOG);
  assert.equal(d.severity, null);
  assert.equal(d.ruleId, null);
});

test('an unclaimed event still gets a check name it can be grouped by', () => {
  assert.equal(evaluateEvent([], trap()).checkName, 'trap 1.3.6.1.6.3.1.1.5.3');
  assert.equal(evaluateEvent([], syslog()).checkName, 'syslog sshd');
  assert.equal(defaultCheckName(syslog({ appName: '' })), 'syslog auth');
});

test('a raise and its paired clear render the same check name', () => {
  // This is the whole mechanism by which linkUp closes what linkDown opened:
  // the alert dedup key is the check name, so the two must agree exactly.
  const rules = [
    { id: 'down', priority: 10, source: 'trap', matchOid: '1.3.6.1.6.3.1.1.5.3',
      matchPattern: 'ifDescr=(\\S+)', action: 'alert', severity: 'critical', checkName: 'link {1}' },
    { id: 'up', priority: 11, source: 'trap', matchOid: '1.3.6.1.6.3.1.1.5.4',
      matchPattern: 'ifDescr=(\\S+)', action: 'clear', severity: 'info', checkName: 'link {1}' },
  ];
  const down = evaluateEvent(rules, trap({ oid: '1.3.6.1.6.3.1.1.5.3' }));
  const up = evaluateEvent(rules, trap({ oid: '1.3.6.1.6.3.1.1.5.4' }));
  assert.equal(down.action, 'alert');
  assert.equal(up.action, 'clear');
  assert.equal(down.checkName, 'link Gi0/1');
  assert.equal(up.checkName, down.checkName);
});

test('a drop rule stops the event before it is stored', () => {
  const rules = [{ id: 'noise', priority: 1, matchPattern: 'debug', action: 'drop' }];
  assert.equal(evaluateEvent(rules, syslog({ message: 'debug chatter' })).action, 'drop');
});

test('the auto-clear deadline travels with the decision', () => {
  const rules = [{ id: 'r', priority: 1, action: 'alert', severity: 'warning',
    checkName: 'x', autoClearSeconds: 3600 }];
  assert.equal(evaluateEvent(rules, trap()).autoClearSeconds, 3600);
});

/* ── the state bus contract ────────────────────────────────────────────── */

test('severities map onto the service states the alert stack reads', () => {
  assert.equal(severityToServiceState(SEVERITY.CRITICAL), SERVICE_STATE.CRITICAL);
  assert.equal(severityToServiceState(SEVERITY.WARNING), SERVICE_STATE.WARNING);
  assert.equal(severityToServiceState(SEVERITY.INFO), SERVICE_STATE.UNKNOWN);
});

test('an unmatched syslog line is coloured but never escalated to critical by accident', () => {
  assert.equal(syslogSeverityHint(0), SEVERITY.CRITICAL);
  assert.equal(syslogSeverityHint(3), SEVERITY.WARNING);
  assert.equal(syslogSeverityHint(6), SEVERITY.INFO);
  assert.equal(syslogSeverityHint(null), SEVERITY.INFO);
});

/* ── SNMPv1 → v2c identity (RFC 3584 §3.1) ─────────────────────────────── */

test('generic v1 traps map onto the standard snmpTraps arcs', () => {
  assert.equal(v1TrapOid('1.3.6.1.4.1.9', 0, 0), '1.3.6.1.6.3.1.1.5.1');   // coldStart
  assert.equal(v1TrapOid('1.3.6.1.4.1.9', 2, 0), '1.3.6.1.6.3.1.1.5.3');   // linkDown
  assert.equal(v1TrapOid('1.3.6.1.4.1.9', 5, 0), '1.3.6.1.6.3.1.1.5.6');
});

test('an enterprise-specific v1 trap becomes enterprise.0.specific', () => {
  assert.equal(v1TrapOid('1.3.6.1.4.1.9', 6, 42), '1.3.6.1.4.1.9.0.42');
  assert.equal(v1TrapOid('1.3.6.1.4.1.9.', 6, 1), '1.3.6.1.4.1.9.0.1');
});

test('a v1 linkDown and a v2c linkDown select the same rule', () => {
  const rules = [{ id: 'ld', priority: 1, matchOid: '1.3.6.1.6.3.1.1.5.3',
    action: 'alert', severity: 'critical', checkName: 'link down' }];
  const asV1 = trap({ oid: v1TrapOid('1.3.6.1.4.1.9', 2, 0) });
  assert.equal(evaluateEvent(rules, asV1).checkName, 'link down');
  assert.equal(evaluateEvent(rules, trap()).checkName, 'link down');
});

/* ── varbind rendering ─────────────────────────────────────────────────── */

test('a printable octet string renders as text', () => {
  assert.equal(renderValue(Buffer.from('GigabitEthernet0/1')), 'GigabitEthernet0/1');
});

test('a binary octet string renders as readable hex, not mojibake', () => {
  assert.equal(renderValue(Buffer.from([0x00, 0x1b, 0x21, 0x3c, 0x4d, 0x5e])),
    '00:1b:21:3c:4d:5e');
});

test('numbers, OID arrays and nullish values all render safely', () => {
  assert.equal(renderValue(42), '42');
  assert.equal(renderValue([1, 3, 6]), '1.3.6');
  assert.equal(renderValue(null), '');
  assert.equal(renderValue(undefined), '');
});

test('a v2c trap PDU yields its trap OID and drops the two housekeeping varbinds', () => {
  const pdu = {
    type: 167,                                    // not PduType.Trap → v2c path
    varbinds: [
      { oid: '1.3.6.1.2.1.1.3.0', value: 12345 },
      { oid: '1.3.6.1.6.3.1.1.4.1.0', value: '1.3.6.1.6.3.1.1.5.3' },
      { oid: '1.3.6.1.2.1.2.2.1.1.7', value: 7 },
      { oid: '1.3.6.1.2.1.2.2.1.2.7', value: Buffer.from('Gi0/1') },
    ],
  };
  const { oid, varbinds, message } = decodeTrap(pdu);
  assert.equal(oid, '1.3.6.1.6.3.1.1.5.3');
  assert.equal(varbinds.length, 2);
  assert.match(message, /1\.3\.6\.1\.2\.1\.2\.2\.1\.2\.7=Gi0\/1/);
  assert.equal(message.includes('1.3.6.1.6.3.1.1.4.1.0'), false);
});

test('a trap with no payload varbinds still produces a usable message', () => {
  const { message } = decodeTrap({
    type: 167,
    varbinds: [{ oid: '1.3.6.1.6.3.1.1.4.1.0', value: '1.3.6.1.6.3.1.1.5.1' }],
  });
  assert.equal(message, 'trap 1.3.6.1.6.3.1.1.5.1');
});

/* ── admission control ─────────────────────────────────────────────────── */

test('a source is admitted up to the ceiling and refused past it', () => {
  const rl = new RateLimiter({ limit: 3, windowMs: 1000 });
  const now = 1_000_000;
  assert.equal(rl.admit('10.0.0.1', now).allowed, true);
  assert.equal(rl.admit('10.0.0.1', now).allowed, true);
  assert.equal(rl.admit('10.0.0.1', now).allowed, true);
  const over = rl.admit('10.0.0.1', now);
  assert.equal(over.allowed, false);
  assert.equal(over.firstDrop, true);
  assert.equal(rl.admit('10.0.0.1', now).firstDrop, false);
});

test('one shouting device does not use up another device s budget', () => {
  const rl = new RateLimiter({ limit: 1, windowMs: 1000 });
  const now = 1_000_000;
  rl.admit('10.0.0.1', now);
  assert.equal(rl.admit('10.0.0.1', now).allowed, false);
  assert.equal(rl.admit('10.0.0.2', now).allowed, true);
});

test('the window rolls and the budget comes back', () => {
  const rl = new RateLimiter({ limit: 1, windowMs: 1000 });
  rl.admit('10.0.0.1', 1_000_000);
  assert.equal(rl.admit('10.0.0.1', 1_000_000).allowed, false);
  assert.equal(rl.admit('10.0.0.1', 1_001_001).allowed, true);
});
