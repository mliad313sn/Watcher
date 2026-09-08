/**
 * End to end across the event plane: a real UDP datagram on a real socket,
 * through the real parser, the real pipeline and the real rule engine, to
 * the message that lands on the state bus.
 *
 * Only the three edges are doubled — Postgres, TimescaleDB and Redis — and
 * they are doubled by recording what they were asked to do, so the
 * assertions are about the SQL and the published payload rather than about
 * a mock's call count. What is being proven is the contract that keeps one
 * alert model in the product: an event-born state message must be
 * indistinguishable from a Nagios-born one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import { REDIS_KEYS, SERVICE_STATE } from '@watcher/shared';
import { EventPipeline } from '../src/receivers/pipeline.js';
import { SyslogReceiver } from '../src/receivers/syslog.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const DEVICE = '22222222-2222-2222-2222-222222222222';

/** A Postgres double that answers the three queries the pipeline makes. */
function fakePg({ devices = [], sources = [], rules = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/FROM tenants/.test(sql)) return { rows: [{ id: TENANT }] };
      if (/FROM devices WHERE address/.test(sql)) return { rows: devices };
      if (/FROM event_sources/.test(sql)) return { rows: sources };
      if (/FROM event_rules/.test(sql)) return { rows: rules };
      if (/INSERT INTO alert_auto_clear/.test(sql)) return { rows: [{ alert_id: 'a1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

function fakeTsdb() {
  const inserted = [];
  return {
    inserted,
    async query(sql, params) {
      if (/INSERT INTO events/.test(sql)) inserted.push(params);
      return { rows: [], rowCount: 1 };
    },
  };
}

function fakeRedis() {
  const published = [];
  return {
    published,
    async publish(channel, payload) { published.push({ channel, payload }); },
  };
}

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

const rule = (over = {}) => ({
  id: 'rule-1', tenant_id: TENANT, name: 'Syslog error', source: 'syslog',
  enabled: true, priority: 50, match_oid: '', match_pattern: '', match_app: '',
  match_facility: null, max_severity: 3, action: 'alert', severity: 'critical',
  check_name: 'syslog {app}', auto_clear_seconds: 3600, ...over,
});

const knownDevice = { id: DEVICE, tenant_id: TENANT, name: 'sw1', address: '127.0.0.1' };

/** Send one datagram to a receiver and wait for it to be fully drained. */
async function deliver(receiver, port, payload) {
  const client = dgram.createSocket('udp4');
  await new Promise((resolve, reject) =>
    client.send(Buffer.from(payload), port, '127.0.0.1', (e) => (e ? reject(e) : resolve())));
  client.close();
  for (let i = 0; i < 200; i++) {
    if (!receiver.draining && receiver.queue.length === 0 && i > 2) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function withReceiver(deps, run) {
  const pipeline = new EventPipeline({ ...deps, log: silentLog });
  const receiver = new SyslogReceiver(
    { port: 0, tcp: false }, { pipeline, log: silentLog });
  // Port 0 lets the OS choose, so the tests never collide with a real syslog.
  await receiver.start();
  const port = receiver.udp.address().port;
  try { await run({ receiver, pipeline, port }); }
  finally { await receiver.stop(); }
}

test('a syslog datagram from a known device raises on the state bus', async () => {
  const pg = fakePg({ devices: [knownDevice], rules: [rule()] });
  const tsdb = fakeTsdb();
  const redis = fakeRedis();

  await withReceiver({ pg, tsdb, redis }, async ({ receiver, port }) => {
    await deliver(receiver, port,
      '<27>1 2026-09-08T22:14:15Z sw1 bgpd 900 - - neighbor 10.0.0.1 Down');

    const state = redis.published.find((p) => p.channel === REDIS_KEYS.eventsState);
    assert.ok(state, 'a state event should have been published');
    const event = JSON.parse(state.payload);

    // The contract: same fields, same meanings, as the Nagios streamer emits.
    assert.equal(event.host, 'sw1');
    assert.equal(event.service, 'syslog bgpd');
    assert.equal(event.kind, 'service');
    assert.equal(event.state, SERVICE_STATE.CRITICAL);
    assert.equal(event.hard, true);
    assert.equal(event.tenantId, TENANT);
    assert.match(event.output, /neighbor 10\.0\.0\.1 Down/);
    assert.equal(event.origin, 'syslog');
    assert.equal(event.originRule, 'Syslog error');
  });
});

test('the raw event is stored with the decision that was taken', async () => {
  const pg = fakePg({ devices: [knownDevice], rules: [rule()] });
  const tsdb = fakeTsdb();
  await withReceiver({ pg, tsdb, redis: fakeRedis() }, async ({ receiver, port }) => {
    await deliver(receiver, port, '<27>1 2026-09-08T22:14:15Z sw1 bgpd - - - session reset');

    assert.equal(tsdb.inserted.length, 1);
    const row = tsdb.inserted[0];
    assert.equal(row[1], TENANT);          // tenant_id
    assert.equal(row[2], 'syslog');        // source
    assert.equal(row[3], DEVICE);          // device_id — resolved from inventory
    assert.equal(row[4], 'sw1');           // device_name
    assert.equal(row[8], 3);               // severity — err
    assert.equal(row[9], 'bgpd');          // app_name
    assert.equal(row[14], 'alert');        // action
    assert.equal(row[15], 'syslog bgpd');  // check_name
  });
});

test('an event from an unknown source is stored but never raises', async () => {
  // The alert-injection defence: anything that can reach the port can claim
  // to be any device, so an unrecognised sender may fill the log and may
  // not page. (ISS-25 on the delivery register.)
  const pg = fakePg({ devices: [], rules: [rule()] });
  const tsdb = fakeTsdb();
  const redis = fakeRedis();

  await withReceiver({ pg, tsdb, redis }, async ({ receiver, port }) => {
    await deliver(receiver, port, '<27>1 2026-09-08T22:14:15Z evil bgpd - - - fake outage');

    assert.equal(tsdb.inserted.length, 1, 'it is still recorded');
    assert.equal(redis.published.length, 0, 'but nothing was raised');
  });
});

test('a source disabled in the allow-list is dropped entirely', async () => {
  const pg = fakePg({
    devices: [knownDevice],
    sources: [{ address: '127.0.0.1', device_id: DEVICE, tenant_id: TENANT,
      label: '', enabled: false, device_name: 'sw1' }],
    rules: [rule()],
  });
  const tsdb = fakeTsdb();
  const redis = fakeRedis();

  await withReceiver({ pg, tsdb, redis }, async ({ receiver, port }) => {
    await deliver(receiver, port, '<27>1 2026-09-08T22:14:15Z sw1 bgpd - - - noise');
    assert.equal(tsdb.inserted.length, 0);
    assert.equal(redis.published.length, 0);
  });
});

test('the allow-list overrides inventory for the name events are attributed to', async () => {
  const pg = fakePg({
    devices: [knownDevice],
    sources: [{ address: '127.0.0.1', device_id: null, tenant_id: TENANT,
      label: 'log-relay', enabled: true, device_name: null }],
    rules: [rule()],
  });
  const redis = fakeRedis();
  await withReceiver({ pg, tsdb: fakeTsdb(), redis }, async ({ receiver, port }) => {
    await deliver(receiver, port, '<27>1 2026-09-08T22:14:15Z x bgpd - - - via relay');
    const state = JSON.parse(redis.published[0].payload);
    assert.equal(state.host, 'log-relay');
  });
});

test('a message no rule claims is stored and does not page', async () => {
  const pg = fakePg({ devices: [knownDevice], rules: [rule()] });
  const tsdb = fakeTsdb();
  const redis = fakeRedis();
  await withReceiver({ pg, tsdb, redis }, async ({ receiver, port }) => {
    // severity 6 (info) — below the rule's maxSeverity of 3.
    await deliver(receiver, port, '<30>1 2026-09-08T22:14:15Z sw1 cron - - - ran a job');
    assert.equal(tsdb.inserted.length, 1);
    assert.equal(tsdb.inserted[0][14], 'log');
    assert.equal(redis.published.length, 0);
  });
});

test('a clearing rule publishes the OK that closes the alert', async () => {
  const pg = fakePg({
    devices: [knownDevice],
    rules: [rule({ id: 'up', priority: 10, match_pattern: 'session established',
      action: 'clear', check_name: 'syslog {app}', max_severity: null })],
  });
  const redis = fakeRedis();
  await withReceiver({ pg, tsdb: fakeTsdb(), redis }, async ({ receiver, port }) => {
    await deliver(receiver, port, '<30>1 2026-09-08T22:14:15Z sw1 bgpd - - - session established');
    const state = JSON.parse(redis.published[0].payload);
    assert.equal(state.state, SERVICE_STATE.OK);
    assert.equal(state.service, 'syslog bgpd');
  });
});

test('a drop rule stops the event before it reaches the store', async () => {
  const pg = fakePg({
    devices: [knownDevice],
    rules: [rule({ id: 'drop', priority: 1, match_pattern: 'chatter',
      action: 'drop', max_severity: null })],
  });
  const tsdb = fakeTsdb();
  const redis = fakeRedis();
  await withReceiver({ pg, tsdb, redis }, async ({ receiver, port }) => {
    await deliver(receiver, port, '<27>1 2026-09-08T22:14:15Z sw1 x - - - chatter chatter');
    assert.equal(tsdb.inserted.length, 0);
    assert.equal(redis.published.length, 0);
  });
});

test('a flood is admitted up to the ceiling and then throttled', async () => {
  const pg = fakePg({ devices: [knownDevice], rules: [rule()] });
  const tsdb = fakeTsdb();
  const redis = fakeRedis();
  const pipeline = new EventPipeline({
    pg, tsdb, redis, log: silentLog, limits: { limit: 5, windowMs: 60_000 },
  });
  const receiver = new SyslogReceiver({ port: 0, tcp: false }, { pipeline, log: silentLog });
  await receiver.start();
  const port = receiver.udp.address().port;
  try {
    for (let i = 0; i < 12; i++) {
      await deliver(receiver, port, `<27>1 2026-09-08T22:14:15Z sw1 bgpd - - - flap ${i}`);
    }
    assert.equal(pipeline.stats.raised, 5, 'exactly the ceiling was raised');
    assert.equal(pipeline.stats.throttled, 7);
    // The throttle announces itself once, so the silence is explained.
    const notice = tsdb.inserted.find((r) => String(r[10]).includes('exceeded'));
    assert.ok(notice, 'the throttle should record why it went quiet');
  } finally {
    await receiver.stop();
  }
});

test('an auto-clearing rule records a deadline for the alert it opened', async () => {
  // Arming happens off the receive path: handling queues the deadline, and
  // the flusher attaches it in one statement once the correlation engine has
  // had a chance to open the alert. Waiting for that inline was a throughput
  // bug — see release-review.test.js.
  const pg = fakePg({ devices: [knownDevice], rules: [rule()] });
  await withReceiver({ pg, tsdb: fakeTsdb(), redis: fakeRedis() },
    async ({ receiver, pipeline, port }) => {
      await deliver(receiver, port, '<27>1 2026-09-08T22:14:15Z sw1 bgpd - - - down');

      assert.equal(pipeline.pendingClears.size, 1, 'a deadline is queued');
      const pending = [...pipeline.pendingClears.values()][0];
      assert.equal(pending.tenantId, TENANT);
      assert.equal(pending.deviceName, 'sw1');
      assert.equal(pending.checkName, 'syslog bgpd');
      assert.ok(pending.at > new Date(), 'the deadline is in the future');

      await pipeline.flushAutoClears();
      const armed = pg.calls.find((c) => /INSERT INTO alert_auto_clear/.test(c.sql));
      assert.ok(armed, 'and the flush attaches it');
      assert.equal(armed.params[1], 'sw1');
      assert.equal(armed.params[2], 'syslog bgpd');
      await pipeline.stop();
    });
});

test('a receiver failure never takes the process down', async () => {
  const pg = fakePg({ devices: [knownDevice], rules: [rule()] });
  const exploding = { async query() { throw new Error('tsdb is gone'); } };
  const redis = fakeRedis();
  await withReceiver({ pg, tsdb: exploding, redis }, async ({ receiver, pipeline, port }) => {
    await deliver(receiver, port, '<27>1 2026-09-08T22:14:15Z sw1 bgpd - - - down');
    assert.equal(pipeline.stats.received, 1);
    assert.equal(redis.published.length, 0, 'nothing is raised on a store failure');
  });
});

test('TCP delivery reaches the same pipeline as UDP', async () => {
  const pg = fakePg({ devices: [knownDevice], rules: [rule()] });
  const redis = fakeRedis();
  const pipeline = new EventPipeline({ pg, tsdb: fakeTsdb(), redis, log: silentLog });
  const receiver = new SyslogReceiver({ port: 0, udp: false }, { pipeline, log: silentLog });
  await receiver.start();
  const port = receiver.tcp.address().port;
  try {
    await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('<27>1 2026-09-08T22:14:15Z sw1 bgpd - - - over tcp\n', () => {
          setTimeout(() => { sock.end(); resolve(); }, 150);
        });
      });
      sock.on('error', reject);
    });
    for (let i = 0; i < 100 && redis.published.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const state = JSON.parse(redis.published[0].payload);
    assert.match(state.output, /over tcp/);
  } finally {
    await receiver.stop();
  }
});
