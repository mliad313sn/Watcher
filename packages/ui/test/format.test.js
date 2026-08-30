import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeAgo } from '../src/format.js';

const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;

test('timeAgo renders compact relative buckets', () => {
  const now = Date.now();
  assert.equal(timeAgo(now), 'now');
  assert.equal(timeAgo(now - 20 * S), 'now');       // < 45s reads as now
  assert.equal(timeAgo(now - 5 * M), '5m');
  assert.equal(timeAgo(now - 3 * H), '3h');
  assert.equal(timeAgo(now - 2 * D), '2d');
  assert.equal(timeAgo(now - 10 * D), '1w');
  assert.equal(timeAgo(now - 60 * D), '2mo');
});

test('timeAgo accepts ISO strings and Date, and rejects junk', () => {
  const iso = new Date(Date.now() - 2 * H).toISOString();
  assert.equal(timeAgo(iso), '2h');
  assert.equal(timeAgo(new Date(Date.now() - 30 * M)), '30m');
  assert.equal(timeAgo('not-a-date'), '');
  assert.equal(timeAgo(undefined), '');
});

test('timeAgo clamps future timestamps to now', () => {
  assert.equal(timeAgo(Date.now() + 5 * M), 'now');
});
