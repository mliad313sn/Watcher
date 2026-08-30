import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceInWindow } from '../src/modules/maintenance/routes.js';

test('empty match covers every device', () => {
  assert.ok(deviceInWindow({}, { name: 'core-sw-01', kind: 'switch' }));
  assert.ok(deviceInWindow(null, { name: 'anything', kind: 'server' }));
});

test('kind restricts the window', () => {
  const m = { kind: 'switch' };
  assert.ok(deviceInWindow(m, { name: 'core-sw-01', kind: 'switch' }));
  assert.ok(!deviceInWindow(m, { name: 'app-srv-01', kind: 'server' }));
});

test('devicePattern is a regex on the name', () => {
  const m = { devicePattern: '^core-sw-' };
  assert.ok(deviceInWindow(m, { name: 'core-sw-01' }));
  assert.ok(!deviceInWindow(m, { name: 'dist-sw-01' }));
});

test('kind AND pattern must both hold', () => {
  const m = { kind: 'switch', devicePattern: '-sfo-' };
  assert.ok(deviceInWindow(m, { name: 'dist-sw-sfo-01', kind: 'switch' }));
  assert.ok(!deviceInWindow(m, { name: 'dist-sw-nyc-01', kind: 'switch' }));
  assert.ok(!deviceInWindow(m, { name: 'app-srv-sfo-03', kind: 'server' }));
});

test('a broken regex matches nothing (fails closed for scoping)', () => {
  assert.ok(!deviceInWindow({ devicePattern: '([' }, { name: 'core-sw-01' }));
});
