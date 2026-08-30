import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLEET, SERVICES, series, rng, metricShape } from '../src/modules/demo/dataset.js';

test('fleet topology references only devices that exist', () => {
  const names = new Set(FLEET.map((d) => d.name));
  for (const d of FLEET) {
    if (d.parent) assert.ok(names.has(d.parent), `parent ${d.parent} of ${d.name} exists`);
  }
  // Every service attaches to a real host.
  for (const s of SERVICES) assert.ok(names.has(s.host), `service host ${s.host} exists`);
});

test('fleet contains a root-cause + suppressible child for the correlation demo', () => {
  const down = FLEET.find((d) => d.state === 1);
  assert.ok(down, 'a device is DOWN (root cause)');
  const child = FLEET.find((d) => d.parent === down.name);
  assert.ok(child, 'the down device has a child to suppress');
});

test('series is deterministic and stays within bounds', () => {
  const opts = { seed: 123, hours: 2, stepMin: 10, base: 40, amp: 15, nowMs: 1_700_000_000_000 };
  const a = series(opts);
  const b = series(opts);
  assert.deepEqual(a, b, 'same seed → identical series');
  assert.ok(a.length > 0);
  for (const p of a) {
    assert.ok(p.value >= 0 && p.value <= 100, `value ${p.value} within [0,100]`);
    assert.ok(p.time instanceof Date);
  }
  // Time is ascending.
  for (let i = 1; i < a.length; i++) assert.ok(a[i].time >= a[i - 1].time);
});

test('trending series converges toward its end target', () => {
  const pts = series({ seed: 7, hours: 4, stepMin: 10, base: 55, amp: 4, end: 97, nowMs: Date.now() });
  const last = pts.at(-1).value;
  assert.ok(last > 88, `ends near the 97 target, got ${last}`);
});

test('db-cluster CPU shape trends to a critical level (matches its alert)', () => {
  const shape = metricShape('db-cluster-01', 'cpu.util.pct');
  assert.equal(shape.end, 97);
});

test('rng is a stable stream for a given seed', () => {
  const r1 = rng(42); const r2 = rng(42);
  assert.equal(r1(), r2());
  assert.equal(r1(), r2());
});
