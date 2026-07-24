import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/modules/auth/password.js';

test('hash → verify roundtrip', async () => {
  const stored = await hashPassword('s3cret-passw0rd');
  assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(await verifyPassword('s3cret-passw0rd', stored), true);
  assert.equal(await verifyPassword('wrong', stored), false);
});

test('rejects malformed stored values', async () => {
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
  assert.equal(await verifyPassword('x', ''), false);
});

test('seeded admin hash verifies with password "admin"', async () => {
  const seeded = 'scrypt$9b808675fb98b417c6f87bf921abad31$fbd23831006fe260113f5d7c42edec933437aa3c0e17e92d996a7b8f84b039f5';
  assert.equal(await verifyPassword('admin', seeded), true);
});
