/**
 * Configuration normalisation, diffing and drift.
 *
 * The tests that matter here are the negative ones: a capture that differs
 * byte for byte from yesterday's and must NOT be reported as a change. A
 * drift alert that fires every night is one nobody reads, which means the
 * night it fires for a real reason nobody reads it either.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseConfig, redactSecrets, configHash, diffConfigs,
  driftStatus, changeSummary, VENDOR_PROFILES,
} from '@watcher/shared/config-drift';

/* ── the volatile lines that make naive tools cry wolf ─────────────────── */

test('a Cisco config that only differs in its own noise hashes the same', () => {
  const monday = [
    'Building configuration...',
    'Current configuration : 4213 bytes',
    '! Last configuration change at 09:14:02 UTC Mon Sep 7 2026 by admin',
    'hostname sw1',
    'ntp clock-period 17179856',
    'interface GigabitEthernet0/1',
    ' description uplink',
  ].join('\n');
  const tuesday = [
    'Building configuration...',
    'Current configuration : 4219 bytes',
    '! Last configuration change at 03:02:55 UTC Tue Sep 8 2026 by admin',
    'hostname sw1',
    'ntp clock-period 17179901',
    'interface GigabitEthernet0/1',
    ' description uplink',
  ].join('\n');

  assert.equal(
    configHash(normaliseConfig(monday, 'cisco-ios')),
    configHash(normaliseConfig(tuesday, 'cisco-ios')),
    'nothing was configured, so nothing changed');
});

test('a real change on the same day is still detected', () => {
  const before = '! Last configuration change at 09:14:02\nhostname sw1\n description uplink';
  const after = '! Last configuration change at 09:20:00\nhostname sw1\n description core-uplink';
  assert.notEqual(
    configHash(normaliseConfig(before, 'cisco-ios')),
    configHash(normaliseConfig(after, 'cisco-ios')));
});

test('NX-OS, Arista, Juniper, MikroTik and FortiOS headers are all volatile', () => {
  const cases = [
    ['cisco-nxos', '!Time: Mon Sep  7 09:00:00 2026\nhostname n9k',
      '!Time: Tue Sep  8 03:00:00 2026\nhostname n9k'],
    ['arista', '! Command: show running-config\n! device: sw (DCS-7050, EOS-4.29)\nhostname sw',
      '! Command: show running-config\n! device: sw (DCS-7050, EOS-4.30)\nhostname sw'],
    ['juniper', '## Last commit: 2026-09-07 09:00:00 UTC by admin\nset system host-name r1',
      '## Last commit: 2026-09-08 03:00:00 UTC by admin\nset system host-name r1'],
    ['mikrotik', '# 2026-09-07 09:00:00 by RouterOS 7.14\n# serial number = ABC123\n/ip address add address=10.0.0.1',
      '# 2026-09-08 03:00:00 by RouterOS 7.14\n# serial number = ABC123\n/ip address add address=10.0.0.1'],
    ['fortinet', '#config-version=FGT-7.4.1\n#buildno=2463\nconfig system global',
      '#config-version=FGT-7.4.2\n#buildno=2571\nconfig system global'],
  ];
  for (const [vendor, a, b] of cases) {
    assert.equal(
      configHash(normaliseConfig(a, vendor)),
      configHash(normaliseConfig(b, vendor)),
      `${vendor} noise should normalise away`);
  }
});

test('a site can add its own volatile patterns', () => {
  const a = 'hostname sw1\nlocal-counter 41\nvlan 10';
  const b = 'hostname sw1\nlocal-counter 99\nvlan 10';
  assert.notEqual(configHash(normaliseConfig(a)), configHash(normaliseConfig(b)));
  assert.equal(
    configHash(normaliseConfig(a, 'generic', ['^local-counter \\d+$'])),
    configHash(normaliseConfig(b, 'generic', ['^local-counter \\d+$'])));
});

test('a broken site pattern is ignored rather than taking the capture down', () => {
  const out = normaliseConfig('hostname sw1', 'generic', ['([unclosed']);
  assert.equal(out, 'hostname sw1');
});

test('line endings, trailing spaces and blank runs are not configuration', () => {
  const crlf = 'hostname sw1\r\ninterface Gi0/1\r\n description up   \r\n';
  const lf = '\n\nhostname sw1\ninterface Gi0/1\n description up\n\n\n\n';
  assert.equal(configHash(normaliseConfig(crlf)), configHash(normaliseConfig(lf)));
});

/* ── secrets ───────────────────────────────────────────────────────────── */

test('passwords and secrets never reach the stored configuration', () => {
  // RSK-50: a backup archive of the estate's configs is a better prize than
  // any single device.
  const raw = [
    'enable secret 5 $1$abcd$eFgHiJkLmNoPqRsTu0',
    'username admin password 7 09414F0B1A',
    'snmp-server community S3cr3tC0mmunity RO',
    'radius-server host 10.0.0.5 key 7 05080F1C2243',
    'set psksecret ENC aVeryLongEncryptedString==',
  ].join('\n');
  const out = redactSecrets(raw);

  for (const secret of ['$1$abcd$eFgHiJkLmNoPqRsTu0', '09414F0B1A', 'S3cr3tC0mmunity',
    '05080F1C2243', 'aVeryLongEncryptedString==']) {
    assert.equal(out.includes(secret), false, `${secret} must not survive redaction`);
  }
  assert.match(out, /<redacted>/);
});

test('redaction keeps the surrounding line so the config still reads', () => {
  const out = redactSecrets('snmp-server community Public RO');
  assert.match(out, /^snmp-server community <redacted> RO$/);
});

test('without a fingerprint key, a rotated secret is invisible in the diff', () => {
  // The honest cost of flat redaction, asserted so nobody is surprised by it.
  const a = normaliseConfig('snmp-server community AAA RO');
  const rotated = normaliseConfig('snmp-server community BBB RO');
  assert.equal(configHash(a), configHash(rotated));
});

test('with a fingerprint key, a rotated secret DOES show as a change', () => {
  const a = normaliseConfig('snmp-server community AAA RO', 'generic', [], 'sitekey');
  const same = normaliseConfig('snmp-server community AAA RO', 'generic', [], 'sitekey');
  const rotated = normaliseConfig('snmp-server community BBB RO', 'generic', [], 'sitekey');

  assert.equal(configHash(a), configHash(same), 'an unchanged secret is not a change');
  assert.notEqual(configHash(a), configHash(rotated), 'a rotation is');
});

test('the fingerprint is keyed, so it is not an offline guessing target', () => {
  // A plain hash of "public" does not survive a dictionary for long.
  const one = redactSecrets('snmp-server community public RO', 'key-one');
  const two = redactSecrets('snmp-server community public RO', 'key-two');
  assert.notEqual(one, two);
  assert.match(one, /<redacted:[0-9a-f]{8}>/);
  assert.equal(one.includes('public'), false);
});

test('a fingerprint never contains the secret and keeps the line readable', () => {
  const out = redactSecrets('password="topsecret"', 'k');
  assert.equal(out.includes('topsecret'), false);
  assert.match(out, /^password="<redacted:[0-9a-f]{8}>"$/);
});

test('an ordinary line that merely mentions a word is not mangled', () => {
  const line = 'description link to password-reset service';
  assert.equal(redactSecrets(line), line);
});

/* ── diffing ───────────────────────────────────────────────────────────── */

test('an unchanged configuration diffs to nothing', () => {
  const d = diffConfigs('a\nb\nc', 'a\nb\nc');
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
  assert.equal(d.hunks.length, 0);
});

test('an added line is reported as added, with its surroundings', () => {
  const d = diffConfigs('a\nb\nc', 'a\nb\nNEW\nc');
  assert.equal(d.added, 1);
  assert.equal(d.removed, 0);
  assert.equal(d.hunks.length, 1);
  const ops = d.hunks[0].lines;
  assert.ok(ops.some((o) => o.op === '+' && o.line === 'NEW'));
  assert.ok(ops.some((o) => o.op === ' ' && o.line === 'b'), 'context is included');
});

test('a removed line is reported as removed', () => {
  const d = diffConfigs('a\nb\nc', 'a\nc');
  assert.equal(d.removed, 1);
  assert.equal(d.added, 0);
});

test('a modified line reads as one removal and one addition', () => {
  const d = diffConfigs(' description uplink', ' description core-uplink');
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
});

test('distant changes are separate hunks, adjacent ones are not', () => {
  const before = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n');
  const after = before.split('\n').map((l, i) => (i === 2 || i === 30 ? `${l}-changed` : l)).join('\n');
  assert.equal(diffConfigs(before, after).hunks.length, 2);

  const adjacent = before.split('\n').map((l, i) => (i === 2 || i === 3 ? `${l}-changed` : l)).join('\n');
  assert.equal(diffConfigs(before, adjacent).hunks.length, 1);
});

test('an enormous configuration summarises instead of allocating a matrix', () => {
  const huge = Array.from({ length: 25_000 }, (_, i) => `line${i}`).join('\n');
  const d = diffConfigs(huge, `${huge}\nextra`);
  assert.equal(d.truncated, true);
  assert.equal(d.hunks.length, 0);
  assert.match(changeSummary(d), /too large/);
});

test('an empty first capture is all additions, not a crash', () => {
  const d = diffConfigs('', 'hostname sw1\nvlan 10');
  assert.equal(d.removed <= 1, true);
  assert.ok(d.added >= 1);
});

test('null inputs are handled as empty', () => {
  assert.equal(diffConfigs(null, null).added, 0);
});

/* ── drift ─────────────────────────────────────────────────────────────── */

test('a device matching its approved baseline is compliant', () => {
  assert.equal(driftStatus({ currentHash: 'abc', baselineHash: 'abc' }), 'compliant');
});

test('a device differing from its approved baseline has drifted', () => {
  assert.equal(driftStatus({ currentHash: 'abc', baselineHash: 'def' }), 'drifted');
});

test('a device with no approved baseline is NOT drifting', () => {
  // Nobody has said what it should be. Reporting it as drift makes the whole
  // view noise on day one, which is how the feature gets turned off in week
  // two.
  assert.equal(driftStatus({ currentHash: 'abc', baselineHash: null }), 'unapproved');
  assert.equal(driftStatus({}), 'unapproved');
});

test('a device we have never captured is unknown, not compliant', () => {
  assert.equal(driftStatus({ currentHash: null, baselineHash: 'abc' }), 'unknown');
});

/* ── summaries ─────────────────────────────────────────────────────────── */

test('the alert line says what an operator needs at 2am', () => {
  assert.equal(changeSummary(diffConfigs('a\nb', 'a\nb\nc')), '1 line added');
  assert.equal(changeSummary(diffConfigs('a\nb\nc', 'a')), '2 lines removed');
  assert.equal(changeSummary(diffConfigs('a\nb', 'a\nZ')), '1 line added, 1 line removed');
  assert.equal(changeSummary(diffConfigs('a', 'a')), 'no change');
  assert.equal(changeSummary(null), 'no change');
});

/* ── profiles ──────────────────────────────────────────────────────────── */

test('every vendor profile carries a command and a label', () => {
  for (const [key, profile] of Object.entries(VENDOR_PROFILES)) {
    assert.ok(profile.command, `${key} needs a capture command`);
    assert.ok(profile.label, `${key} needs a label`);
    assert.ok(Array.isArray(profile.volatile), `${key} needs a volatile list`);
  }
});

test('an unknown vendor falls back to generic rather than throwing', () => {
  assert.equal(normaliseConfig('hostname sw1', 'not-a-vendor'), 'hostname sw1');
});
