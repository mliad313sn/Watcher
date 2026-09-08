/**
 * The capture worker, against a scripted transport.
 *
 * The behaviours worth guarding are the ones that decide whether the feature
 * is trusted: an unchanged device must not create a version, an empty
 * capture must never overwrite a good history, a first capture must not
 * announce itself as a change, and drift must mean "differs from what
 * somebody approved" rather than "differs from last night".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ConfigBackup, sshCapture } from '../src/config/backup.js';

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

const CONFIG_A = ['hostname sw1', 'interface GigabitEthernet0/1', ' description uplink',
  'ip route 0.0.0.0 0.0.0.0 10.0.0.1'].join('\n');
const CONFIG_B = ['hostname sw1', 'interface GigabitEthernet0/1', ' description core-uplink',
  'ip route 0.0.0.0 0.0.0.0 10.0.0.1'].join('\n');

const target = (over = {}) => ({
  device_id: 'd1', tenant_id: 't1', vendor: 'cisco-ios', credential_id: null,
  command: '', volatile_extra: [], name: 'sw1', address: '10.0.0.1', ...over,
});

/** A Postgres double that keeps just enough state to be meaningful. */
function fakePg({ latest = null, baseline = null } = {}) {
  const inserted = [];
  const captures = [];
  return {
    inserted, captures,
    get latest() { return latest; },
    async query(sql, params) {
      if (/FROM device_configs/.test(sql)) return { rows: latest ? [latest] : [] };
      if (/FROM config_baselines/.test(sql)) return { rows: baseline ? [{ content_hash: baseline }] : [] };
      if (/INSERT INTO device_configs/.test(sql)) {
        inserted.push(params);
        latest = { id: 'cfg-new', content: params[3], content_hash: params[2] };
        return { rows: [{ id: 'cfg-new' }] };
      }
      if (/INSERT INTO config_captures/.test(sql)) { captures.push(params); return { rows: [] }; }
      if (/FROM config_targets/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}

function fakeRedis() {
  const published = [];
  return { published, async publish(c, p) { published.push(JSON.parse(p)); } };
}

const backup = (pg, redis, capture, opts) =>
  new ConfigBackup({ pg, redis, log: silentLog, capture }, opts);

/* ── storing versions ──────────────────────────────────────────────────── */

test('a first capture stores a version and does not announce a change', async () => {
  // Announcing every device as "changed" on the first night is how the
  // feature gets muted before it has ever been useful.
  const pg = fakePg();
  const redis = fakeRedis();
  const out = await backup(pg, redis, async () => CONFIG_A).captureOne(target());

  assert.equal(out.status, 'ok');
  assert.equal(pg.inserted.length, 1);
  assert.equal(redis.published[0].state, 0);
  assert.match(redis.published[0].output, /First configuration captured/);
});

test('an unchanged device creates no new version', async () => {
  // A table with one row per device per night is a table nobody opens.
  const { normaliseConfig, configHash } = await import('@watcher/shared/config-drift');
  const normalised = normaliseConfig(CONFIG_A, 'cisco-ios');
  const pg = fakePg({ latest: { id: 'cfg-1', content: normalised, content_hash: configHash(normalised) } });
  const redis = fakeRedis();

  const out = await backup(pg, redis, async () => CONFIG_A).captureOne(target());
  assert.equal(out.status, 'unchanged');
  assert.equal(pg.inserted.length, 0);
  assert.equal(redis.published[0].state, 0);
});

test('config noise alone does not create a version', async () => {
  const { normaliseConfig, configHash } = await import('@watcher/shared/config-drift');
  const monday = `! Last configuration change at 09:00:00\n${CONFIG_A}\nntp clock-period 17179856`;
  const tuesday = `! Last configuration change at 03:00:00\n${CONFIG_A}\nntp clock-period 17179999`;
  const normalised = normaliseConfig(monday, 'cisco-ios');
  const pg = fakePg({ latest: { id: 'c1', content: normalised, content_hash: configHash(normalised) } });

  const out = await backup(pg, fakeRedis(), async () => tuesday).captureOne(target());
  assert.equal(out.status, 'unchanged');
  assert.equal(pg.inserted.length, 0);
});

test('a real change creates a version and counts the lines', async () => {
  const { normaliseConfig, configHash } = await import('@watcher/shared/config-drift');
  const normalised = normaliseConfig(CONFIG_A, 'cisco-ios');
  const pg = fakePg({ latest: { id: 'c1', content: normalised, content_hash: configHash(normalised) } });
  const redis = fakeRedis();

  const out = await backup(pg, redis, async () => CONFIG_B).captureOne(target());
  assert.equal(out.status, 'ok');
  assert.equal(pg.inserted.length, 1);
  assert.equal(pg.inserted[0][6], 1, 'one line added');
  assert.equal(pg.inserted[0][7], 1, 'one line removed');
  assert.match(out.summary, /1 line added, 1 line removed/);
});

/* ── the dangerous cases ───────────────────────────────────────────────── */

test('an empty capture is refused rather than stored as a version', async () => {
  // The most dangerous outcome in the whole feature: an empty "success"
  // stores an empty version and reads as a device whose entire
  // configuration was deleted.
  const pg = fakePg();
  const redis = fakeRedis();
  const out = await backup(pg, redis, async () => '').captureOne(target());

  assert.equal(out.status, 'failed');
  assert.equal(pg.inserted.length, 0);
  assert.equal(redis.published[0].state, 2);
});

test('a nearly-empty capture is refused too', async () => {
  const pg = fakePg();
  const out = await backup(pg, fakeRedis(), async () => '\n\n  \n').captureOne(target());
  assert.equal(out.status, 'failed');
  assert.equal(pg.inserted.length, 0);
});

test('a transport failure is recorded and raises, not swallowed', async () => {
  // A device whose capture has failed for a week is the one whose config you
  // will most want and least have.
  const pg = fakePg();
  const redis = fakeRedis();
  const out = await backup(pg, redis, async () => { throw new Error('Permission denied (publickey)'); })
    .captureOne(target());

  assert.equal(out.status, 'failed');
  assert.match(out.error, /publickey/);
  assert.equal(pg.captures.length, 1);
  assert.equal(pg.captures[0][2], 'failed');
  assert.equal(redis.published[0].state, 2);
  assert.match(redis.published[0].output, /publickey/);
});

test('every attempt is recorded, including the ones that changed nothing', async () => {
  const { normaliseConfig, configHash } = await import('@watcher/shared/config-drift');
  const normalised = normaliseConfig(CONFIG_A, 'cisco-ios');
  const pg = fakePg({ latest: { id: 'c1', content: normalised, content_hash: configHash(normalised) } });
  await backup(pg, fakeRedis(), async () => CONFIG_A).captureOne(target());
  assert.equal(pg.captures.length, 1);
  assert.equal(pg.captures[0][2], 'unchanged');
});

/* ── drift ─────────────────────────────────────────────────────────────── */

test('a change with no approved baseline is reported, not alerted', async () => {
  // Nobody has said what this device should be.
  const { normaliseConfig, configHash } = await import('@watcher/shared/config-drift');
  const normalised = normaliseConfig(CONFIG_A, 'cisco-ios');
  const pg = fakePg({ latest: { id: 'c1', content: normalised, content_hash: configHash(normalised) } });
  const redis = fakeRedis();

  await backup(pg, redis, async () => CONFIG_B).captureOne(target());
  assert.equal(redis.published[0].state, 0);
  assert.match(redis.published[0].output, /no approved baseline/);
});

test('a change away from the approved baseline raises a warning', async () => {
  const { normaliseConfig, configHash } = await import('@watcher/shared/config-drift');
  const a = normaliseConfig(CONFIG_A, 'cisco-ios');
  const pg = fakePg({ latest: { id: 'c1', content: a, content_hash: configHash(a) },
    baseline: configHash(a) });
  const redis = fakeRedis();

  await backup(pg, redis, async () => CONFIG_B).captureOne(target());
  assert.equal(redis.published[0].state, 1);
  assert.match(redis.published[0].output, /differs from the approved baseline/);
});

test('a change back TO the baseline resolves rather than alerts', async () => {
  // Drift means differing from what somebody approved — including coming
  // back into line, which must clear the alert.
  const { normaliseConfig, configHash } = await import('@watcher/shared/config-drift');
  const a = normaliseConfig(CONFIG_A, 'cisco-ios');
  const b = normaliseConfig(CONFIG_B, 'cisco-ios');
  const pg = fakePg({ latest: { id: 'c1', content: b, content_hash: configHash(b) },
    baseline: configHash(a) });
  const redis = fakeRedis();

  await backup(pg, redis, async () => CONFIG_A).captureOne(target());
  assert.equal(redis.published[0].state, 0);
  assert.match(redis.published[0].output, /matches the baseline/);
});

test('configuration alerts ride the ordinary state bus', async () => {
  // So correlation, maintenance windows, on-call and runbooks all apply.
  const pg = fakePg();
  const redis = fakeRedis();
  await backup(pg, redis, async () => CONFIG_A).captureOne(target());
  const ev = redis.published[0];
  assert.equal(ev.host, 'sw1');
  assert.equal(ev.service, 'configuration');
  assert.equal(ev.kind, 'service');
  assert.equal(ev.hard, true);
  assert.equal(ev.tenantId, 't1');
  assert.equal(ev.origin, 'config-backup');
});

/* ── secrets ───────────────────────────────────────────────────────────── */

test('a captured secret never reaches the stored version', async () => {
  const pg = fakePg();
  await backup(pg, fakeRedis(),
    async () => `${CONFIG_A}\nsnmp-server community MySecretString RO`)
    .captureOne(target());

  const stored = pg.inserted[0][3];
  assert.equal(stored.includes('MySecretString'), false);
  assert.match(stored, /<redacted/);
});

test('a fingerprint key makes a secret rotation a real version', async () => {
  const { normaliseConfig, configHash } = await import('@watcher/shared/config-drift');
  const before = `${CONFIG_A}\nsnmp-server community OldOne RO`;
  const after = `${CONFIG_A}\nsnmp-server community NewOne RO`;
  const normalised = normaliseConfig(before, 'cisco-ios', [], 'sitekey');
  const pg = fakePg({ latest: { id: 'c1', content: normalised, content_hash: configHash(normalised) } });

  const out = await backup(pg, fakeRedis(), async () => after, { fingerprintKey: 'sitekey' })
    .captureOne(target());
  assert.equal(out.status, 'ok', 'the rotation was detected');
  assert.equal(pg.inserted[0][3].includes('NewOne'), false, 'without storing the new secret');
});

/* ── vendor handling ───────────────────────────────────────────────────── */

test('the vendor profile supplies the command, and a target may override it', async () => {
  const asked = [];
  const capture = async (host, command) => { asked.push(command); return CONFIG_A; };
  await backup(fakePg(), fakeRedis(), capture).captureOne(target({ vendor: 'juniper' }));
  await backup(fakePg(), fakeRedis(), capture).captureOne(
    target({ vendor: 'juniper', command: 'show config | display json' }));

  assert.match(asked[0], /display set/);
  assert.equal(asked[1], 'show config | display json');
});

/* ── the ssh transport itself ──────────────────────────────────────────── */

/** A spawn double: an EventEmitter with the streams ssh would provide. */
function fakeSpawn(script) {
  const seen = [];
  const impl = (cmd, args) => {
    seen.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    setImmediate(() => script(child));
    return child;
  };
  impl.seen = seen;
  return impl;
}

test('ssh is invoked in batch mode so a prompt fails instead of hanging', async () => {
  // Without BatchMode a capture against an unknown host blocks on a password
  // prompt until the timeout, every night, silently.
  const spawnImpl = fakeSpawn((child) => {
    child.stdout.emit('data', CONFIG_A);
    child.emit('close', 0);
  });
  const out = await sshCapture('10.0.0.1', 'show running-config', { spawnImpl });
  assert.equal(out, CONFIG_A);

  const args = spawnImpl.seen[0].args.join(' ');
  assert.equal(spawnImpl.seen[0].cmd, 'ssh');
  assert.match(args, /BatchMode=yes/);
  assert.match(args, /watcher@10\.0\.0\.1/);
  assert.match(args, /show running-config/);
});

test('a non-zero exit carries ssh stderr, so auth is tellable from routing', async () => {
  const spawnImpl = fakeSpawn((child) => {
    child.stderr.emit('data', 'Permission denied (publickey,password).');
    child.emit('close', 255);
  });
  await assert.rejects(
    () => sshCapture('10.0.0.1', 'show run', { spawnImpl }),
    /Permission denied \(publickey/);
});

test('a device that never answers is killed rather than held forever', async () => {
  const spawnImpl = fakeSpawn(() => { /* silence */ });
  await assert.rejects(
    () => sshCapture('10.0.0.1', 'show run', { spawnImpl, timeoutMs: 60 }),
    /timed out/);
});

test('a device stuck in a loop is cut off rather than filling the disk', async () => {
  const spawnImpl = fakeSpawn((child) => {
    const chunk = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 20; i++) child.stdout.emit('data', chunk);
  });
  await assert.rejects(
    () => sshCapture('10.0.0.1', 'show run', { spawnImpl, timeoutMs: 5000 }),
    /exceeded/);
});

test('a missing ssh binary is reported as such, not as a device fault', async () => {
  const spawnImpl = fakeSpawn((child) => child.emit('error', new Error('spawn ssh ENOENT')));
  await assert.rejects(
    () => sshCapture('10.0.0.1', 'show run', { spawnImpl }),
    /ssh could not be run/);
});

test('a custom port, user and identity reach the command line', async () => {
  const spawnImpl = fakeSpawn((child) => { child.stdout.emit('data', 'x'); child.emit('close', 0); });
  await sshCapture('10.0.0.1', 'show run',
    { spawnImpl, port: 2222, user: 'netops', identity: '/etc/watcher/id_ed25519' });
  const args = spawnImpl.seen[0].args;
  assert.ok(args.includes('2222'));
  assert.ok(args.includes('/etc/watcher/id_ed25519'));
  assert.ok(args.includes('netops@10.0.0.1'));
});
