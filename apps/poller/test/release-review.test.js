/**
 * Regressions from the 1.1.0 release-readiness review.
 *
 * Each of these is a defect that was in the release candidate and is not in
 * the release. They are kept as tests rather than as changelog entries
 * because the two that matter most — a stored credential and a stalled
 * receiver — are both silent, and neither would be noticed again until it
 * had already cost something.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import snmp from 'net-snmp';
import { EventPipeline } from '../src/receivers/pipeline.js';
import { trapToEvent } from '../src/receivers/traps.js';

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };
const TENANT = '11111111-1111-1111-1111-111111111111';
const DEVICE = '22222222-2222-2222-2222-222222222222';

function fakePg({ rules = [], devices = [], alertFound = true } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/FROM tenants/.test(sql)) return { rows: [{ id: TENANT }] };
      if (/FROM devices WHERE address/.test(sql)) return { rows: devices };
      if (/FROM event_sources/.test(sql)) return { rows: [] };
      if (/FROM event_rules/.test(sql)) return { rows: rules };
      if (/INSERT INTO alert_auto_clear/.test(sql)) {
        return { rows: alertFound ? [{ alert_id: 'a1' }] : [] };
      }
      return { rows: [] };
    },
  };
}
const fakeTsdb = () => {
  const inserted = [];
  return { inserted, async query(sql, p) { if (/INSERT INTO events/.test(sql)) inserted.push(p); return { rows: [] }; } };
};
const fakeRedis = () => {
  const published = [];
  return { published, async publish(c, p) { published.push(JSON.parse(p)); } };
};

const rule = (over = {}) => ({
  id: 'r1', tenant_id: TENANT, name: 'Link down', source: 'trap', enabled: true,
  priority: 10, match_oid: '', match_pattern: '', match_app: '',
  match_facility: null, max_severity: null, action: 'alert', severity: 'critical',
  check_name: 'link', auto_clear_seconds: 3600, ...over,
});
const device = { id: DEVICE, tenant_id: TENANT, name: 'sw1', address: '10.0.0.1' };

const trapEvent = (over = {}) => ({
  source: 'trap', sourceIp: '10.0.0.1', timestamp: new Date(),
  oid: '1.3.6.1.6.3.1.1.5.3', facility: null, severity: null,
  facilityName: '', severityName: '', appName: '',
  message: 'ifDescr=Gi0/1', detail: {}, ...over,
});

/* ── R1: the SNMP community must never be stored ──────────────────────── */

test('a received trap does not carry its community string into the event', () => {
  // The event store is readable by any viewer through GET /api/events, and a
  // v1/v2c community is the shared secret that authenticates the trap.
  // Recording it would publish the credential for every device in the estate
  // to the least privileged role in the product.
  const captured = trapToEvent({
    rinfo: { address: '10.0.0.1' },
    pdu: {
      type: 167,
      community: 'S3cr3tC0mmunity',
      varbinds: [
        { oid: '1.3.6.1.6.3.1.1.4.1.0', value: '1.3.6.1.6.3.1.1.5.3' },
        { oid: '1.3.6.1.2.1.2.2.1.2.7', value: Buffer.from('Gi0/1') },
      ],
    },
  });

  const serialised = JSON.stringify(captured);
  assert.equal(serialised.includes('S3cr3tC0mmunity'), false,
    'the community string must not appear anywhere in the stored event');
  assert.equal(captured.detail.auth, 'community', 'but that it authenticated is recorded');
});

test('an SNMPv3 user NAME is kept — it is not a secret', () => {
  // The auth and privacy keys are the secrets, and they never reach this code.
  // "Which identity sent this" is a real operational question.
  const captured = trapToEvent({
    rinfo: { address: '10.0.0.1' },
    pdu: { type: 167, user: 'watcher-trap',
      varbinds: [{ oid: '1.3.6.1.6.3.1.1.4.1.0', value: '1.3.6.1.6.3.1.1.5.1' }] },
  });
  assert.equal(captured.detail.user, 'watcher-trap');
  assert.equal(captured.detail.auth, 'usm');
});

/* ── R2: arming a deadline must not stall the receiver ────────────────── */

test('handling an event does not wait for its auto-clear deadline', async () => {
  // The bug: the deadline was attached to an alert row the correlation engine
  // had not created yet, so the pipeline retried with backoff — up to a second
  // and a half — inside the receiver's drain loop, on every raising event.
  // Every shipped rule sets an auto-clear, so this was the default path.
  const pg = fakePg({ rules: [rule()], devices: [device] });
  const pipeline = new EventPipeline({ pg, tsdb: fakeTsdb(), redis: fakeRedis(), log: silentLog });

  const started = Date.now();
  for (let i = 0; i < 50; i++) await pipeline.handle(trapEvent());
  const elapsed = Date.now() - started;

  assert.equal(pipeline.stats.raised, 50);
  assert.ok(elapsed < 500, `50 raising events took ${elapsed}ms — the receive path is blocking`);
  // Nothing was written to alert_auto_clear on the hot path at all.
  assert.equal(pg.calls.filter((c) => /INSERT INTO alert_auto_clear/.test(c.sql)).length, 0);
  await pipeline.stop();
});

test('deadlines are attached in one batched statement, off the receive path', async () => {
  const pg = fakePg({ rules: [rule()], devices: [device] });
  const pipeline = new EventPipeline({ pg, tsdb: fakeTsdb(), redis: fakeRedis(), log: silentLog });

  await pipeline.handle(trapEvent());
  await pipeline.handle(trapEvent({ message: 'ifDescr=Gi0/2' }));
  assert.equal(pipeline.pendingClears.size, 1, 'one alert identity, one deadline');

  const attached = await pipeline.flushAutoClears();
  assert.equal(attached, 1);
  const armed = pg.calls.filter((c) => /INSERT INTO alert_auto_clear/.test(c.sql));
  assert.equal(armed.length, 1, 'one statement, not one per event');
  assert.equal(pipeline.pendingClears.size, 0);
  await pipeline.stop();
});

test('a thousand events from one flapping port arm one deadline, refreshed', async () => {
  const pg = fakePg({ rules: [rule()], devices: [device] });
  const pipeline = new EventPipeline({ pg, tsdb: fakeTsdb(), redis: fakeRedis(), log: silentLog,
    limits: { limit: 5000, windowMs: 60_000 } });

  for (let i = 0; i < 1000; i++) await pipeline.handle(trapEvent());
  assert.equal(pipeline.pendingClears.size, 1);
  await pipeline.stop();
});

test('a deadline whose alert never appeared is let go rather than retried forever', async () => {
  // The engine deduped or suppressed it; there is nothing to close.
  const pg = fakePg({ rules: [rule()], devices: [device], alertFound: false });
  const pipeline = new EventPipeline({ pg, tsdb: fakeTsdb(), redis: fakeRedis(), log: silentLog });

  await pipeline.handle(trapEvent());
  assert.equal(pipeline.pendingClears.size, 1);
  for (let i = 0; i < 8; i++) await pipeline.flushAutoClears();
  assert.equal(pipeline.pendingClears.size, 0, 'given up on after the grace period');
  await pipeline.stop();
});

test('a failed flush keeps the deadlines for the next pass', async () => {
  const pg = fakePg({ rules: [rule()], devices: [device] });
  const pipeline = new EventPipeline({ pg, tsdb: fakeTsdb(), redis: fakeRedis(), log: silentLog });
  await pipeline.handle(trapEvent());

  const good = pg.query.bind(pg);
  pg.query = async (sql, p) => {
    if (/INSERT INTO alert_auto_clear/.test(sql)) throw new Error('database gone');
    return good(sql, p);
  };
  assert.equal(await pipeline.flushAutoClears(), 0);
  assert.equal(pipeline.pendingClears.size, 1, 'not lost');
  await pipeline.stop();
});

test('the pending map is bounded — a flood cannot grow it without limit', async () => {
  const pg = fakePg({ rules: [rule({ check_name: 'link {1}', match_pattern: 'ifDescr=(\\S+)' })],
    devices: [device] });
  const pipeline = new EventPipeline({ pg, tsdb: fakeTsdb(), redis: fakeRedis(), log: silentLog,
    limits: { limit: 100_000, windowMs: 60_000 } });

  for (let i = 0; i < 21_000; i++) {
    await pipeline.handle(trapEvent({ message: `ifDescr=Gi0/${i}` }));
  }
  assert.ok(pipeline.pendingClears.size <= 20_000,
    `pending deadlines grew to ${pipeline.pendingClears.size}`);
  await pipeline.stop();
});

/* ── the fix must not have broken the feature ─────────────────────────── */

test('a clearing rule still resolves, and still writes no deadline', async () => {
  const pg = fakePg({
    rules: [rule({ id: 'up', action: 'clear', auto_clear_seconds: null })],
    devices: [device],
  });
  const redis = fakeRedis();
  const pipeline = new EventPipeline({ pg, tsdb: fakeTsdb(), redis, log: silentLog });
  await pipeline.handle(trapEvent());

  assert.equal(pipeline.stats.cleared, 1);
  assert.equal(pipeline.pendingClears.size, 0);
  assert.equal(redis.published[0].state, 0);
  await pipeline.stop();
});

test('a rule with no auto-clear arms nothing', async () => {
  const pg = fakePg({ rules: [rule({ auto_clear_seconds: null })], devices: [device] });
  const pipeline = new EventPipeline({ pg, tsdb: fakeTsdb(), redis: fakeRedis(), log: silentLog });
  await pipeline.handle(trapEvent());
  assert.equal(pipeline.stats.raised, 1);
  assert.equal(pipeline.pendingClears.size, 0);
  await pipeline.stop();
});

test('the PduType constant used by the decoder is the one net-snmp ships', () => {
  // Guards the v1-vs-v2c branch against a library rename: getting this wrong
  // would silently read every v2c trap through the v1 path and lose its OID.
  assert.equal(typeof snmp.PduType.Trap, 'number');
  assert.notEqual(snmp.PduType.Trap, snmp.PduType.TrapV2);
});
