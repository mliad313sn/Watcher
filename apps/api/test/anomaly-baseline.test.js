import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, robustBaseline, anomalyScore, judge } from '../src/modules/anomaly/baseline.js';

test('median handles odd, even, and empty inputs', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.ok(Number.isNaN(median([])));
});

test('robustBaseline refuses to judge on thin history', () => {
  assert.equal(robustBaseline([1, 2, 3], { minSamples: 12 }), null);
  const b = robustBaseline(Array.from({ length: 24 }, (_, i) => 40 + (i % 5)), { minSamples: 12 });
  assert.ok(b && b.n === 24 && b.median >= 40 && b.median <= 44);
});

test('a spike against a noisy-but-stable baseline is anomalous; normal wiggle is not', () => {
  // ~45% CPU with everyday noise.
  const history = Array.from({ length: 200 }, (_, i) => 45 + Math.sin(i / 7) * 4 + (i % 3));
  const b = robustBaseline(history);
  assert.ok(b);
  assert.equal(judge(47, b).anomalous, false, 'ordinary value stays quiet');
  const spike = judge(96, b);
  assert.equal(spike.anomalous, true, '96% on a 45% baseline alerts');
  assert.ok(spike.z > 4, `z should be large, got ${spike.z}`);
});

test('a flat baseline still detects real movement without dividing by zero', () => {
  const b = robustBaseline(Array(30).fill(3));
  assert.ok(b && b.mad === 0);
  assert.equal(judge(3.02, b).anomalous, false, 'tiny wiggle on flat line stays quiet (minDeltaPct)');
  assert.equal(judge(30, b).anomalous, true, '10x jump on a flat line alerts');
  assert.ok(Number.isFinite(anomalyScore(30, b)));
});

test('history containing past spikes does not mask the next one (MAD vs σ)', () => {
  // Mostly 40, with a handful of old 100% spikes that would inflate a stddev.
  const history = [...Array(180).fill(40), ...Array(8).fill(100)];
  const b = robustBaseline(history);
  const verdict = judge(95, b);
  assert.equal(verdict.anomalous, true, 'MAD baseline still flags 95 despite polluted history');
});

test('drops below baseline are anomalies too (traffic going to zero)', () => {
  const history = Array.from({ length: 100 }, () => 800 + Math.random() * 60);
  const b = robustBaseline(history);
  const verdict = judge(5, b);
  assert.equal(verdict.anomalous, true);
  assert.ok(verdict.z < 0, 'negative z encodes the direction');
});
