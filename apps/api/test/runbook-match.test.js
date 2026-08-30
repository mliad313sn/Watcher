import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRunbook } from '../src/modules/runbooks/match.js';

const server = { kind: 'server', tags: { site: 'hq' } };
const rbCpu = { name: 'High CPU', match: { checkPattern: 'CPU|Load', kind: 'server' }, priority: 0, created_at: '2026-01-01' };
const rbDb = { name: 'DB incident', match: { devicePattern: '^db-', minSeverity: 'critical' }, priority: 5, created_at: '2026-01-02' };
const rbAny = { name: 'Catch-all', match: {}, priority: 0, created_at: '2026-01-03' };

test('matches on check pattern + kind', () => {
  const r = matchRunbook({ alert: { severity: 'warning', device_name: 'app-01', check_name: 'CPU Load' }, device: server, runbooks: [rbCpu, rbAny] });
  assert.equal(r.name, 'High CPU');
});

test('higher priority wins among matches', () => {
  const alert = { severity: 'critical', device_name: 'db-cluster-01', check_name: 'CPU Load' };
  const r = matchRunbook({ alert, device: server, runbooks: [rbCpu, rbDb, rbAny] });
  assert.equal(r.name, 'DB incident'); // priority 5 beats High CPU
});

test('minSeverity gate blocks lower-severity alerts', () => {
  const alert = { severity: 'warning', device_name: 'db-1', check_name: 'x' };
  const r = matchRunbook({ alert, device: server, runbooks: [rbDb] });
  assert.equal(r, null);
});

test('kind mismatch is not matched', () => {
  const r = matchRunbook({ alert: { severity: 'critical', device_name: 'sw-1', check_name: 'CPU' }, device: { kind: 'switch' }, runbooks: [rbCpu] });
  assert.equal(r, null);
});

test('tags must be a superset', () => {
  const rb = { name: 't', match: { tags: { site: 'sfo' } }, created_at: '2026-01-01' };
  assert.equal(matchRunbook({ alert: { severity: 'info' }, device: { tags: { site: 'hq' } }, runbooks: [rb] }), null);
  assert.ok(matchRunbook({ alert: { severity: 'info' }, device: { tags: { site: 'sfo', rack: 'a' } }, runbooks: [rb] }));
});

test('empty match is a catch-all; more specific rule wins on tie priority', () => {
  const alert = { severity: 'critical', device_name: 'app-01', check_name: 'CPU' };
  const r = matchRunbook({ alert, device: server, runbooks: [rbAny, rbCpu] });
  assert.equal(r.name, 'High CPU'); // 2 criteria beats 0 at equal priority
});

test('no runbooks → null', () => {
  assert.equal(matchRunbook({ alert: { severity: 'critical' }, device: server, runbooks: [] }), null);
});
