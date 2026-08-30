import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whoIsOnCall } from '../src/modules/oncall/resolver.js';

const WEEK = 604800;
const anchor = Date.parse('2026-01-05T09:00:00Z'); // a Monday 09:00
const participants = [
  { position: 0, name: 'Ada', contact: { type: 'webhook', url: 'http://a' } },
  { position: 1, name: 'Bo', contact: { type: 'webhook', url: 'http://b' } },
  { position: 2, name: 'Cy', contact: { type: 'webhook', url: 'http://c' } },
];
const schedule = { handoffAt: anchor, rotationIntervalS: WEEK };

test('week 0 → first participant', () => {
  const r = whoIsOnCall({ schedule, participants, nowMs: anchor + 3 * 86400e3 });
  assert.equal(r.onCall.name, 'Ada');
  assert.equal(r.source, 'rotation');
  assert.equal(r.index, 0);
});

test('rotation advances and wraps modulo participants', () => {
  assert.equal(whoIsOnCall({ schedule, participants, nowMs: anchor + WEEK * 1000 + 1 }).onCall.name, 'Bo');
  assert.equal(whoIsOnCall({ schedule, participants, nowMs: anchor + WEEK * 2000 + 1 }).onCall.name, 'Cy');
  assert.equal(whoIsOnCall({ schedule, participants, nowMs: anchor + WEEK * 3000 + 1 }).onCall.name, 'Ada'); // wrap
});

test('nextHandoff is the start of the following shift', () => {
  const r = whoIsOnCall({ schedule, participants, nowMs: anchor + 1000 });
  assert.equal(r.nextHandoffMs, anchor + WEEK * 1000);
});

test('an active override wins over the rotation', () => {
  const overrides = [{
    name: 'Zoe (holiday cover)', contact: { type: 'slack', url: 'http://z' },
    startsAt: anchor + 1000, endsAt: anchor + 2 * 86400e3,
  }];
  const r = whoIsOnCall({ schedule, participants, overrides, nowMs: anchor + 86400e3 });
  assert.equal(r.onCall.name, 'Zoe (holiday cover)');
  assert.equal(r.source, 'override');
  assert.equal(r.overrideEndsMs, anchor + 2 * 86400e3);
});

test('an expired override does not apply', () => {
  const overrides = [{ name: 'Zoe', contact: {}, startsAt: anchor, endsAt: anchor + 1000 }];
  const r = whoIsOnCall({ schedule, participants, overrides, nowMs: anchor + 86400e3 });
  assert.equal(r.source, 'rotation');
});

test('empty rotation → nobody on call', () => {
  const r = whoIsOnCall({ schedule, participants: [], nowMs: anchor });
  assert.equal(r.onCall, null);
  assert.equal(r.source, 'none');
});

test('pre-start clock still resolves to a valid participant', () => {
  const r = whoIsOnCall({ schedule, participants, nowMs: anchor - WEEK * 500 });
  assert.ok(['Ada', 'Bo', 'Cy'].includes(r.onCall.name));
});
