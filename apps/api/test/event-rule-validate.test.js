/**
 * Rule validation. Each case here is a rule that would pass a schema check,
 * sit in the list looking correct, and do nothing at 3am — which is the
 * worst failure a monitoring system has, because it is indistinguishable
 * from silence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRule, rowToRule } from '../src/modules/events/routes.js';

test('an ordinary rule is accepted', () => {
  assert.equal(validateRule({
    name: 'Link down', matchOid: '1.3.6.1.6.3.1.1.5.3',
    action: 'alert', severity: 'critical', checkName: 'link down',
  }), null);
});

test('a broken regex is refused with a reason', () => {
  const why = validateRule({ matchPattern: '([unclosed' });
  assert.match(why, /regular expression/);
});

test('an OID that is not an OID is refused', () => {
  assert.match(validateRule({ matchOid: 'IF-MIB::linkDown' }), /numeric OID/);
  assert.match(validateRule({ matchOid: '1.3.6.x' }), /numeric OID/);
});

test('an OID with leading or trailing dots is accepted', () => {
  assert.equal(validateRule({ matchOid: '.1.3.6.1.6.3.1.1.5.3' }), null);
  assert.equal(validateRule({ matchOid: '1.3.6.1.4.1.9.' }), null);
});

test('a clear rule with an empty check name is refused', () => {
  // It would clear the per-event default name, which never equals the name
  // the raising rule produced — so the alert stays open forever.
  assert.match(validateRule({ action: 'clear', checkName: '' }), /same checkName/);
});

test('a check name using a capture group without a pattern is refused', () => {
  // Renders as "link " for every port, folding the whole switch onto one
  // alert row and hiding every failure after the first.
  assert.match(validateRule({ checkName: 'link {1}' }), /capture group/);
});

test('a capture group with a pattern that provides one is accepted', () => {
  assert.equal(validateRule({ checkName: 'link {1}', matchPattern: 'ifDescr=(\\S+)' }), null);
});

test('a named placeholder is not mistaken for a capture group', () => {
  assert.equal(validateRule({ checkName: 'trap {oid}' }), null);
});

test('a database row maps onto the shape the rule engine reads', () => {
  const rule = rowToRule({
    id: 'r1', name: 'n', source: null, enabled: true, priority: 10,
    match_oid: '1.3.6', match_pattern: 'x', match_app: 'sshd',
    match_facility: 4, max_severity: 3, action: 'alert', severity: 'warning',
    check_name: 'c', auto_clear_seconds: 60,
  });
  assert.equal(rule.source, 'any');            // NULL in the column means both
  assert.equal(rule.matchOid, '1.3.6');
  assert.equal(rule.matchFacility, 4);
  assert.equal(rule.maxSeverity, 3);
  assert.equal(rule.autoClearSeconds, 60);
});

test('facility zero survives the row mapping', () => {
  assert.equal(rowToRule({ match_facility: 0, max_severity: 0 }).matchFacility, 0);
  assert.equal(rowToRule({ match_facility: 0, max_severity: 0 }).maxSeverity, 0);
});
