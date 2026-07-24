import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateCalculator } from '../src/rate.js';

// Minimal in-memory Redis stand-in for the two calls RateCalculator uses.
function fakeRedis() {
  const store = new Map();
  return {
    async hgetall(k) { return store.get(k) ?? {}; },
    async hset(k, obj) { store.set(k, { ...(store.get(k) ?? {}), ...obj }); },
    async expire() {},
  };
}

test('first sample returns null, second yields a per-second rate', async () => {
  const rc = new RateCalculator(fakeRedis());
  assert.equal(await rc.rate('d', 'if.in.bps', 'eth0', 1000n, { nowMs: 0 }), null);
  // +8000 units over 8s = 1000/s
  assert.equal(await rc.rate('d', 'if.in.bps', 'eth0', 9000n, { nowMs: 8000 }), 1000);
});

test('REGRESSION M1: Counter64 values beyond 2^53 stay exact', async () => {
  const rc = new RateCalculator(fakeRedis());
  const base = (1n << 60n);            // far above Number's 2^53 exact range
  await rc.rate('d', 'm', 'i', base, { is64: true, nowMs: 0 });
  const rate = await rc.rate('d', 'm', 'i', base + 1_000_000n, { is64: true, nowMs: 1000 });
  assert.equal(rate, 1_000_000); // exact — Number math would have drifted
});

test('64-bit counter wrap is recovered', async () => {
  const rc = new RateCalculator(fakeRedis());
  const nearMax = (1n << 64n) - 500n;
  await rc.rate('d', 'm', 'i', nearMax, { is64: true, nowMs: 0 });
  // wraps past 2^64: 500 to reach max + 500 after = delta 1000 over 1s
  const rate = await rc.rate('d', 'm', 'i', 500n, { is64: true, nowMs: 1000 });
  assert.equal(rate, 1000);
});

test('an implausible jump (reset/reboot) is rejected as null', async () => {
  const rc = new RateCalculator(fakeRedis());
  await rc.rate('d', 'm', 'i', (1n << 63n), { is64: true, nowMs: 0 });
  // negative delta that is too large to be a single wrap → not a rate
  const rate = await rc.rate('d', 'm', 'i', 10n, { is64: true, nowMs: 1000 });
  assert.equal(rate, null);
});
