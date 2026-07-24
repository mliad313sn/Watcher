import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integrateDowntime } from '../src/modules/metrics/availability.js';

const DAY = 86400e3;
const now = 1_700_000_000_000;
const windowStartMs = now - 30 * DAY;

test('up the entire window → zero downtime', () => {
  const down = integrateDowntime({ transitions: [], initialBad: false, windowStartMs, nowMs: now });
  assert.equal(down, 0);
});

test('REGRESSION #8: down for the entire window with no in-window transitions → full downtime', () => {
  // Previously reported 100% availability because currentBad was seeded false
  // when there were no in-window rows. With initialBad=true it is now correct.
  const down = integrateDowntime({ transitions: [], initialBad: true, windowStartMs, nowMs: now });
  assert.equal(down, now - windowStartMs);
});

test('partial outage integrates the bad segment only', () => {
  const downStart = windowStartMs + 10 * DAY;
  const recover = windowStartMs + 12 * DAY;
  const down = integrateDowntime({
    transitions: [
      { time: downStart, to_state: 2 }, // went CRITICAL
      { time: recover, to_state: 0 },   // recovered
    ],
    initialBad: false,
    windowStartMs,
    nowMs: now,
  });
  assert.equal(down, recover - downStart);
});

test('still-down at window end counts up to now', () => {
  const downStart = windowStartMs + 29 * DAY;
  const down = integrateDowntime({
    transitions: [{ time: downStart, to_state: 1 }],
    initialBad: false,
    windowStartMs,
    nowMs: now,
  });
  assert.equal(down, now - downStart);
});
