/**
 * Remote proxy behaviour.
 *
 * The properties tested here are the ones that decide whether distributed
 * monitoring is trustworthy or actively dangerous: that observations survive
 * the link failing, that a bounded buffer keeps the *recent* ones, that a
 * batch is not discarded until the far end has taken it, and that a silent
 * proxy is treated as an emergency rather than as quiet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ForwardBuffer, retryDelay, isStale, proxyHealth } from '@watcher/shared/forward';
import { ProxyAgent } from '../src/proxy/agent.js';

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/* ── the buffer ────────────────────────────────────────────────────────── */

test('observations queue and come back in order', () => {
  const b = new ForwardBuffer({ batchSize: 2 });
  b.push([{ n: 1 }, { n: 2 }, { n: 3 }]);
  assert.equal(b.size, 3);
  assert.deepEqual(b.peek(), [{ n: 1 }, { n: 2 }]);
});

test('peek does not remove — a batch survives a failed send', () => {
  // The failure this prevents: deleting on send loses exactly the
  // observations that were in flight when the link went down.
  const b = new ForwardBuffer({ batchSize: 2 });
  b.push([{ n: 1 }, { n: 2 }, { n: 3 }]);
  b.peek();
  b.peek();
  assert.equal(b.size, 3);
});

test('commit removes only what was confirmed', () => {
  const b = new ForwardBuffer({ batchSize: 2 });
  b.push([{ n: 1 }, { n: 2 }, { n: 3 }]);
  b.commit(2);
  assert.equal(b.size, 1);
  assert.deepEqual(b.peek(), [{ n: 3 }]);
});

test('committing more than is held does not underflow', () => {
  const b = new ForwardBuffer();
  b.push([{ n: 1 }]);
  b.commit(50);
  assert.equal(b.size, 0);
});

test('past the bound the OLDEST observations are dropped, not the newest', () => {
  // Monitoring data is perishable. After a two-day outage an operator needs
  // the site's current state, not a faithful replay of Tuesday.
  const b = new ForwardBuffer({ maxItems: 3, batchSize: 10 });
  b.push([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }]);
  assert.equal(b.size, 3);
  assert.deepEqual(b.peek(), [{ n: 3 }, { n: 4 }, { n: 5 }]);
});

test('what was dropped is counted, so loss is visible rather than silent', () => {
  const b = new ForwardBuffer({ maxItems: 2 });
  b.push([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
  assert.equal(b.stats().dropped, 2);
  assert.equal(b.stats().capacity, 2);
});

test('an empty push is a no-op', () => {
  const b = new ForwardBuffer();
  assert.equal(b.push([]), 0);
  assert.equal(b.size, 0);
});

test('a single observation may be pushed without wrapping it in an array', () => {
  const b = new ForwardBuffer();
  b.push({ n: 1 });
  assert.equal(b.size, 1);
});

test('draining empties the buffer for a graceful shutdown', () => {
  const b = new ForwardBuffer();
  b.push([{ n: 1 }, { n: 2 }]);
  assert.equal(b.drain().length, 2);
  assert.equal(b.size, 0);
});

/* ── backoff ───────────────────────────────────────────────────────────── */

test('backoff grows exponentially and then stops growing', () => {
  const at = (attempt, r) => retryDelay(attempt, { random: () => r });
  assert.equal(at(0, 1), 1000);
  assert.equal(at(1, 1), 2000);
  assert.equal(at(3, 1), 8000);
  assert.equal(at(20, 1), 300_000);
  assert.equal(at(999, 1), 300_000);        // clamped, never overflowing
});

test('full jitter spreads the herd across the whole interval', () => {
  // When a central API restarts, every proxy discovers it in the same second.
  // Retrying on the same schedule is how a recovering API is knocked over.
  assert.equal(retryDelay(3, { random: () => 0 }), 0);
  assert.equal(retryDelay(3, { random: () => 0.5 }), 4000);
  assert.equal(retryDelay(3, { random: () => 0.999 }), 7992);
});

test('a negative attempt does not produce a negative delay', () => {
  assert.ok(retryDelay(-5, { random: () => 0.5 }) >= 0);
});

/* ── silence ───────────────────────────────────────────────────────────── */

const proxy = (over = {}) => ({
  status: 'active', lastSeenAt: new Date('2026-09-08T12:00:00Z').toISOString(),
  staleAfterSeconds: 300, queueDepth: 0, ...over,
});
const at = (iso) => new Date(iso).getTime();

test('a proxy reporting inside its deadline is not stale', () => {
  assert.equal(isStale(proxy(), at('2026-09-08T12:04:00Z')), false);
});

test('a proxy past its deadline is stale', () => {
  assert.equal(isStale(proxy(), at('2026-09-08T12:06:00Z')), true);
});

test('each site gets its own deadline — a satellite link is not a campus', () => {
  const slow = proxy({ staleAfterSeconds: 3600 });
  assert.equal(isStale(slow, at('2026-09-08T12:30:00Z')), false);
  assert.equal(isStale(slow, at('2026-09-08T13:30:00Z')), true);
});

test('a proxy that has never reported is not stale — it is not yet enrolled', () => {
  // Paging someone on the day they create a proxy is how they learn to
  // ignore the alert that matters.
  assert.equal(isStale(proxy({ lastSeenAt: null }), at('2026-09-09T00:00:00Z')), false);
  assert.equal(proxyHealth(proxy({ lastSeenAt: null, status: 'pending' })), 'never connected');
});

test('a disabled proxy is not stale — it was switched off on purpose', () => {
  assert.equal(isStale(proxy({ status: 'disabled' }), at('2026-09-09T00:00:00Z')), false);
  assert.equal(proxyHealth(proxy({ status: 'disabled' })), 'disabled');
});

test('an unparseable last-seen does not become a false alarm', () => {
  assert.equal(isStale(proxy({ lastSeenAt: 'never' }), at('2026-09-09T00:00:00Z')), false);
});

test('health names silence apart from being down', () => {
  // Nobody knows whether the site is down. We know we stopped hearing.
  assert.equal(proxyHealth(proxy(), at('2026-09-08T12:01:00Z')), 'healthy');
  assert.equal(proxyHealth(proxy(), at('2026-09-08T12:30:00Z')), 'silent');
});

test('a backlog is reported before it becomes loss', () => {
  assert.equal(proxyHealth(proxy({ queueDepth: 900 }), at('2026-09-08T12:01:00Z')), 'behind');
});

/* ── the agent against a scripted API ──────────────────────────────────── */

/** A fetch double that records calls and replays scripted answers. */
function scriptedApi(script) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, init, body: init.body ? JSON.parse(init.body) : null,
        token: init.headers['x-proxy-token'] ?? null });
      const answer = script[path];
      const resolved = typeof answer === 'function' ? answer(calls.length) : answer;
      return {
        ok: (resolved?.status ?? 200) < 400,
        status: resolved?.status ?? 200,
        text: async () => JSON.stringify(resolved?.body ?? {}),
      };
    },
  };
}

test('a first start enrols and stores the credential it is issued', async () => {
  const api = scriptedApi({
    '/api/proxy/enrol': { body: { proxyToken: 'wpt_issued', proxy: { id: 'p1', name: 'gru' } } },
  });
  const agent = new ProxyAgent(
    { url: 'https://watcher.example', enrol: 'wpe_onetime' },
    { log: silentLog, fetch: api.fetch });

  const out = await agent.enrolIfNeeded();
  assert.equal(out.enrolled, true);
  assert.equal(agent.token, 'wpt_issued');
  assert.equal(api.calls[0].body.secret, 'wpe_onetime');
  assert.equal(api.calls[0].token, null, 'enrolment carries no credential yet');
});

test('a proxy that already has a credential does not re-enrol', async () => {
  const api = scriptedApi({});
  const agent = new ProxyAgent({ url: 'https://w.example', token: 'wpt_existing' },
    { log: silentLog, fetch: api.fetch });
  assert.deepEqual(await agent.enrolIfNeeded(), { enrolled: false });
  assert.equal(api.calls.length, 0);
});

test('a proxy with neither credential nor secret refuses to start', async () => {
  const agent = new ProxyAgent({ url: 'https://w.example' },
    { log: silentLog, fetch: scriptedApi({}).fetch });
  await assert.rejects(() => agent.enrolIfNeeded(), /WATCHER_PROXY_TOKEN/);
});

test('observations are delivered and only then dropped from the buffer', async () => {
  const api = scriptedApi({
    '/api/proxy/report': { body: { acceptedMetrics: 2, acceptedStates: 1 } },
  });
  const agent = new ProxyAgent({ url: 'https://w.example', token: 't' },
    { log: silentLog, fetch: api.fetch });

  agent.report({
    metrics: [{ device: 'sw1', metric: 'cpu.util', value: 40 },
      { device: 'sw1', metric: 'mem.used.pct', value: 60 }],
    states: [{ device: 'sw1', check: 'ping', state: 0 }],
  });
  assert.equal(agent.buffer.size, 3);

  assert.equal(await agent.flushOnce(), true);
  assert.equal(agent.buffer.size, 0);

  const sent = api.calls[0].body;
  assert.equal(sent.metrics.length, 2);
  assert.equal(sent.states.length, 1);
  assert.equal(sent.metrics[0].kind, undefined, 'the internal tag is not sent');
  assert.equal(api.calls[0].token, 't');
});

test('a failed delivery keeps everything buffered for the next attempt', async () => {
  const api = scriptedApi({ '/api/proxy/report': { status: 502, body: { error: 'bad gateway' } } });
  const agent = new ProxyAgent({ url: 'https://w.example', token: 't' },
    { log: silentLog, fetch: api.fetch });

  agent.report({ metrics: [{ device: 'sw1', metric: 'cpu.util', value: 40 }] });
  assert.equal(await agent.flushOnce(), false);
  assert.equal(agent.buffer.size, 1, 'nothing was lost');
  assert.equal(agent.failures, 1);
});

test('an outage then a recovery delivers everything that was buffered', async () => {
  let up = false;
  const api = scriptedApi({
    '/api/proxy/report': () => (up
      ? { body: { acceptedMetrics: 1 } }
      : { status: 503, body: { error: 'down' } }),
  });
  const agent = new ProxyAgent({ url: 'https://w.example', token: 't', batchSize: 2 },
    { log: silentLog, fetch: api.fetch });

  for (let i = 0; i < 6; i++) {
    agent.report({ metrics: [{ device: 'sw1', metric: 'cpu.util', value: i }] });
    await agent.flushOnce();
  }
  assert.equal(agent.buffer.size, 6, 'the whole outage is held');
  assert.ok(agent.failures >= 6);

  up = true;
  while (await agent.flushOnce()) { /* drain */ }
  assert.equal(agent.buffer.size, 0);
  assert.equal(agent.failures, 0, 'a success resets the backoff');
});

test('a rejected credential is not retried as though it were transient', async () => {
  const api = scriptedApi({ '/api/proxy/report': { status: 401, body: { error: 'nope' } } });
  const agent = new ProxyAgent({ url: 'https://w.example', token: 'stale' },
    { log: silentLog, fetch: api.fetch });
  agent.report({ metrics: [{ device: 'sw1', metric: 'cpu.util', value: 1 }] });
  assert.equal(await agent.flushOnce(), false);
  assert.equal(agent.buffer.size, 1);
});

test('flushing an empty buffer costs no request', async () => {
  const api = scriptedApi({});
  const agent = new ProxyAgent({ url: 'https://w.example', token: 't' },
    { log: silentLog, fetch: api.fetch });
  assert.equal(await agent.flushOnce(), false);
  assert.equal(api.calls.length, 0);
});

test('the reported queue depth lets the far end see a backlog forming', async () => {
  const api = scriptedApi({ '/api/proxy/report': { body: {} } });
  const agent = new ProxyAgent({ url: 'https://w.example', token: 't', batchSize: 1 },
    { log: silentLog, fetch: api.fetch });
  agent.report({ metrics: [1, 2, 3].map((v) => ({ device: 'sw1', metric: 'm', value: v })) });
  await agent.flushOnce();
  assert.equal(api.calls[0].body.queueDepth, 3);
});

test('assignments are fetched and handed to the scheduler', async () => {
  let given = null;
  const api = scriptedApi({
    '/api/proxy/assignments': { body: { proxy: { id: 'p1', name: 'gru' },
      devices: [{ id: 'd1', name: 'sw1', address: '10.0.0.1' }] } },
  });
  const agent = new ProxyAgent({ url: 'https://w.example', token: 't' },
    { log: silentLog, fetch: api.fetch, onAssignments: (d) => { given = d; } });

  await agent.fetchAssignments();
  assert.equal(given.length, 1);
  assert.equal(given[0].name, 'sw1');
  assert.equal(agent.identity.name, 'gru');
});

test('a heartbeat failure is survivable — the far end is what notices', async () => {
  const api = scriptedApi({ '/api/proxy/heartbeat': { status: 500, body: {} } });
  const agent = new ProxyAgent({ url: 'https://w.example', token: 't' },
    { log: silentLog, fetch: api.fetch });
  assert.equal(await agent.heartbeat(), false);
});

test('the delay is zero while healthy and backs off after failures', () => {
  const agent = new ProxyAgent({ url: 'https://w.example', token: 't' },
    { log: silentLog, fetch: scriptedApi({}).fetch });
  assert.equal(agent.nextDelay(), 0);
  agent.failures = 3;
  assert.ok(agent.nextDelay() <= 4000);
});

/* ── the scheduler in assigned (proxy) mode ────────────────────────────── */

test('assignments from the API become running jobs', async () => {
  const { Scheduler } = await import('../src/scheduler.js');
  const s = new Scheduler({ pg: null, log: silentLog, connectors: new Map(),
    getCredential: async () => ({}) });
  assert.equal(s.assigned, false);
  s.setDevices([
    { id: 'd1', name: 'sw1', address: '10.0.0.1', protocol: 'snmp', interval_s: 60 },
    { id: 'd2', name: 'sw2', address: '10.0.0.2', protocol: 'snmp', interval_s: 30 },
  ]);
  assert.equal(s.assigned, true);
  assert.equal(s.jobs.size, 2);
  s.stop();
});

test('a device moved to another proxy stops being polled here', async () => {
  // Two sites reporting on one device makes it flap between two truths.
  const { Scheduler } = await import('../src/scheduler.js');
  const s = new Scheduler({ pg: null, log: silentLog, connectors: new Map(),
    getCredential: async () => ({}) });
  s.setDevices([
    { id: 'd1', name: 'sw1', address: '10.0.0.1', protocol: 'snmp', interval_s: 60 },
    { id: 'd2', name: 'sw2', address: '10.0.0.2', protocol: 'snmp', interval_s: 60 },
  ]);
  s.setDevices([{ id: 'd1', name: 'sw1', address: '10.0.0.1', protocol: 'snmp', interval_s: 60 }]);
  assert.equal(s.jobs.size, 1);
  assert.ok(s.jobs.has('d1:snmp'));
  s.stop();
});

test('one device polled over two protocols gets two jobs', async () => {
  const { Scheduler } = await import('../src/scheduler.js');
  const s = new Scheduler({ pg: null, log: silentLog, connectors: new Map(),
    getCredential: async () => ({}) });
  s.setDevices([
    { id: 'd1', name: 'sw1', address: '10.0.0.1', protocol: 'snmp', interval_s: 60 },
    { id: 'd1', name: 'sw1', address: '10.0.0.1', protocol: 'winrm', interval_s: 300 },
  ]);
  assert.equal(s.jobs.size, 2);
  s.stop();
});

test('reload does nothing in assigned mode — there is no database to read', async () => {
  const { Scheduler } = await import('../src/scheduler.js');
  const exploding = { query() { throw new Error('there is no database at a remote site'); } };
  const s = new Scheduler({ pg: exploding, log: silentLog, connectors: new Map(),
    getCredential: async () => ({}) });
  s.setDevices([{ id: 'd1', name: 'sw1', address: '10.0.0.1', protocol: 'snmp', interval_s: 60 }]);
  await s.reload();                    // must not throw
  assert.equal(s.jobs.size, 1);
  s.stop();
});

test('metrics are forwarded to the agent rather than written locally', async () => {
  const { MetricWriter } = await import('../src/metric-writer.js');
  const forwarded = [];
  const writer = new MetricWriter(
    { tsdb: { query() { throw new Error('a proxy holds no database credential'); } },
      redis: { publish: async () => {} }, log: silentLog });
  writer.forwardTo({ report: (batch) => forwarded.push(batch) });

  writer.push({ deviceId: 'd1', metric: 'cpu.util', value: 42 });
  assert.equal(writer.buffer.length, 0, 'nothing is queued for the database');
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].metrics[0].deviceId, 'd1');
  assert.equal(forwarded[0].metrics[0].value, 42);
  await writer.close();
});

test('a non-finite sample is still refused in proxy mode', async () => {
  const { MetricWriter } = await import('../src/metric-writer.js');
  const forwarded = [];
  const writer = new MetricWriter({ tsdb: {}, redis: {}, log: silentLog });
  writer.forwardTo({ report: (b) => forwarded.push(b) });
  writer.push({ deviceId: 'd1', metric: 'cpu.util', value: NaN });
  assert.equal(forwarded.length, 0);
  await writer.close();
});

test('a proxy-mode scheduler starts with no database at all', async () => {
  // The boot-order bug this guards: start() ran the database-driven reload
  // before anything had marked the process as a proxy, so a remote poller —
  // which has no configuration database in front of it — died on startup and
  // never reached the code that would have fetched its assignments.
  const { Scheduler } = await import('../src/scheduler.js');
  const exploding = { query() { throw new Error('no database at a remote site'); } };
  const s = new Scheduler({ pg: exploding, log: silentLog, connectors: new Map(),
    getCredential: async () => ({}), assigned: true });

  await s.start();                       // must not throw
  assert.equal(s.jobs.size, 0, 'nothing runs until the API sends assignments');

  s.setDevices([{ id: 'd1', name: 'sw1', address: '10.0.0.1', protocol: 'snmp', interval_s: 60 }]);
  assert.equal(s.jobs.size, 1);
  s.stop();
});

test('a central scheduler still reads its assignments from the database', async () => {
  const { Scheduler } = await import('../src/scheduler.js');
  let asked = 0;
  const pg = { async query() { asked++; return { rows: [] }; } };
  const s = new Scheduler({ pg, log: silentLog, connectors: new Map(),
    getCredential: async () => ({}) });
  await s.start();
  assert.equal(asked, 1, 'the reload happened');
  assert.equal(s.assigned, false);
  s.stop();
});
