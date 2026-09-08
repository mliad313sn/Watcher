/**
 * Query bounding for the flow routes.
 *
 * These are the numbers that stand between a curious URL and a query that
 * scans the whole retention. `?hours=100000` and `?limit=999999` are one
 * keystroke apart from the legitimate ones, and a flow table is exactly the
 * table where that difference is a production incident.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { windowHours, limitOf, ROLLUP_AFTER_HOURS } from '../src/modules/flow/routes.js';

test('the default window is a day', () => {
  assert.equal(windowHours(undefined), 24);
  assert.equal(windowHours({}), 24);
});

test('a window is clamped to the retention, not honoured as asked', () => {
  assert.equal(windowHours({ hours: 100_000 }), 24 * 14);
  assert.equal(windowHours({ hours: 0 }), 1);
  assert.equal(windowHours({ hours: -5 }), 1);
});

test('a window that is not a number falls back rather than reaching SQL', () => {
  assert.equal(windowHours({ hours: 'all' }), 24);
  assert.equal(windowHours({ hours: '' }), 1);   // '' is 0, which clamps up
  assert.equal(windowHours({ hours: NaN }), 24);
});

test('a legitimate window passes through untouched', () => {
  assert.equal(windowHours({ hours: 1 }), 1);
  assert.equal(windowHours({ hours: '72' }), 72);
  assert.equal(windowHours({ hours: 336 }), 336);
});

test('a limit is bounded at both ends', () => {
  assert.equal(limitOf({}), 20);
  assert.equal(limitOf({ limit: 999_999 }), 200);
  assert.equal(limitOf({ limit: 0 }), 1);
  assert.equal(limitOf({ limit: 'lots' }), 20);
  assert.equal(limitOf({ limit: 50 }), 50);
});

test('a caller-supplied fallback is respected', () => {
  assert.equal(limitOf({}, 5), 5);
  assert.equal(limitOf({ limit: 'nope' }, 5), 5);
});

test('the rollup threshold sits inside the detail retention', () => {
  // The rollup must take over while detail rows still exist, or a window
  // between the two reads an empty table and reports zero traffic.
  assert.ok(ROLLUP_AFTER_HOURS < 24 * 14);
  assert.ok(ROLLUP_AFTER_HOURS >= 24);
});
