#!/usr/bin/env node
/**
 * Schema migration runner.
 *
 * Watcher's schema was applied only through Docker's
 * `/docker-entrypoint-initdb.d`, which runs **once, on an empty data
 * volume**. A fresh install therefore got everything and an existing install
 * upgrading to a new version got nothing — the API would start and every new
 * route would fail on a table that was never created. That is a release
 * blocker for anything claiming to be upgradeable, and this closes it.
 *
 *   node scripts/migrate.mjs            apply everything pending
 *   node scripts/migrate.mjs --dry-run  say what would be applied
 *   node scripts/migrate.mjs --status   what is applied, what is pending
 *
 * Two properties it must have, and does:
 *
 *  · **Adopting an existing database is safe.** A 1.0.0 install has no
 *    migration table but very much has the tables. Re-running 001_init on it
 *    would fail, and forcing an operator to hand-edit a ledger before they
 *    can upgrade is how upgrades get skipped. So a pre-existing database is
 *    detected and its already-shipped files are recorded as applied without
 *    being run.
 *  · **A file is applied once, and cannot change afterwards.** Each is
 *    recorded with the checksum of what actually ran. Editing a shipped
 *    migration then makes the next run refuse and say so, rather than
 *    silently diverging one estate's schema from every other.
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { splitStatements, requiresAutocommit } from '@watcher/shared/sql-split';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_ROOT = join(HERE, '..', 'infra', 'sql');

/**
 * The files that a 1.0.0-rc.1 install already has, because they were applied
 * by the container's init hook before this runner existed. Recorded as
 * applied — never re-run — when adopting such a database.
 */
const PRE_RUNNER_BASELINE = {
  postgres: [
    '001_init.sql', '002_seed.sql', '003_hardening.sql', '004_escalation.sql',
    '005_oncall.sql', '006_runbooks.sql', '007_status.sql', '008_assignment.sql',
    '009_sso.sql', '010_maintenance.sql', '011_api_tokens.sql', '012_config_as_code.sql',
  ],
  timescale: ['001_init.sql', '002_dedup.sql'],
};

/** A table that exists if and only if the database was ever initialised. */
const MARKER = { postgres: 'alerts', timescale: 'metrics' };

const DATABASES = {
  postgres: {
    dir: join(SQL_ROOT, 'postgres'),
    config: () => ({
      host: process.env.PG_HOST ?? 'localhost',
      port: Number(process.env.PG_PORT ?? 5432),
      database: process.env.PG_DATABASE ?? 'watcher',
      user: process.env.PG_USER ?? 'watcher',
      password: process.env.PG_PASSWORD ?? 'watcher',
    }),
  },
  timescale: {
    dir: join(SQL_ROOT, 'timescale'),
    config: () => ({
      host: process.env.TSDB_HOST ?? 'localhost',
      port: Number(process.env.TSDB_PORT ?? 5433),
      database: process.env.TSDB_DATABASE ?? 'watcher_metrics',
      user: process.env.TSDB_USER ?? 'watcher',
      password: process.env.TSDB_PASSWORD ?? 'watcher',
    }),
  },
};

const checksum = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      adopted     boolean NOT NULL DEFAULT false
    )`);
}

/** Does this database predate the runner — tables but no ledger? */
async function isPreRunner(client, marker) {
  const { rows } = await client.query(
    `SELECT to_regclass('public.schema_migrations') AS ledger,
            to_regclass($1) AS marker`, [`public.${marker}`]);
  return !rows[0].ledger && !!rows[0].marker;
}

async function applyFile(client, dir, filename, { transactional }) {
  const sql = await readFile(join(dir, filename), 'utf8');
  const statements = splitStatements(sql);
  if (!statements.length) return { statements: 0, sql };

  /* Statements that TimescaleDB refuses inside a transaction force the whole
     file to run without one. Said out loud rather than silently downgraded:
     such a file can half-apply, and the operator needs to know which. */
  const autocommit = !transactional || statements.some(requiresAutocommit);

  if (!autocommit) await client.query('BEGIN');
  try {
    for (const statement of statements) await client.query(statement);
    if (!autocommit) await client.query('COMMIT');
  } catch (err) {
    if (!autocommit) await client.query('ROLLBACK').catch(() => {});
    err.message = `${filename}: ${err.message}`;
    throw err;
  }
  return { statements: statements.length, sql, autocommit };
}

async function migrateOne(name, { dryRun, statusOnly }) {
  const db = DATABASES[name];
  const files = (await readdir(db.dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = new pg.Client(db.config());

  try {
    await client.connect();
  } catch (err) {
    console.error(`  ${name}: cannot connect — ${err.message}`);
    return { name, ok: false, applied: 0 };
  }

  try {
    const adopting = await isPreRunner(client, MARKER[name]);
    await ensureLedger(client);

    if (adopting) {
      // Recorded, never run: this database already has them.
      for (const filename of PRE_RUNNER_BASELINE[name] ?? []) {
        if (!files.includes(filename)) continue;
        const sql = await readFile(join(db.dir, filename), 'utf8');
        await client.query(
          `INSERT INTO schema_migrations (filename, checksum, adopted)
           VALUES ($1, $2, true) ON CONFLICT (filename) DO NOTHING`,
          [filename, checksum(sql)]);
      }
      console.log(`  ${name}: adopted an existing database `
        + `(${PRE_RUNNER_BASELINE[name].length} file(s) recorded as already applied)`);
    }

    const { rows: done } = await client.query(
      'SELECT filename, checksum FROM schema_migrations');
    const applied = new Map(done.map((r) => [r.filename, r.checksum]));

    // A shipped migration that changed after it ran means two estates now
    // have different schemas from the same version number. Refuse.
    for (const filename of files) {
      if (!applied.has(filename)) continue;
      const sql = await readFile(join(db.dir, filename), 'utf8');
      const now = checksum(sql);
      if (applied.get(filename) !== now) {
        throw new Error(
          `${filename} has changed since it was applied `
          + `(recorded ${applied.get(filename)}, now ${now}). `
          + `A shipped migration must never be edited — add a new file instead.`);
      }
    }

    const pending = files.filter((f) => !applied.has(f));

    if (statusOnly) {
      console.log(`  ${name}: ${applied.size} applied, ${pending.length} pending`);
      for (const f of pending) console.log(`    pending  ${f}`);
      return { name, ok: true, applied: 0, pending: pending.length };
    }
    if (!pending.length) {
      console.log(`  ${name}: up to date (${applied.size} applied)`);
      return { name, ok: true, applied: 0 };
    }
    if (dryRun) {
      for (const f of pending) console.log(`  ${name}: would apply ${f}`);
      return { name, ok: true, applied: 0, pending: pending.length };
    }

    for (const filename of pending) {
      const started = Date.now();
      const { statements, sql, autocommit } = await applyFile(client, db.dir, filename, {
        transactional: name === 'postgres',
      });
      await client.query(
        'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
        [filename, checksum(sql)]);
      console.log(`  ${name}: applied ${filename} `
        + `(${statements} statements, ${Date.now() - started}ms`
        + `${autocommit ? ', no transaction — see below' : ''})`);
      if (autocommit) {
        console.log('           this file could not run in a transaction '
          + '(TimescaleDB forbids it for hypertables and continuous aggregates); '
          + 'if it failed part-way, the ledger did not record it and the next run retries.');
      }
    }
    return { name, ok: true, applied: pending.length };
  } finally {
    await client.end().catch(() => {});
  }
}

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const statusOnly = args.has('--status');
const only = [...args].find((a) => !a.startsWith('--'));

console.log(statusOnly ? 'Watcher schema status' : 'Watcher schema migration');

const names = only ? [only] : Object.keys(DATABASES);
let failed = false;
let total = 0;

for (const name of names) {
  if (!DATABASES[name]) {
    console.error(`unknown database "${name}" — expected one of ${Object.keys(DATABASES).join(', ')}`);
    failed = true;
    continue;
  }
  try {
    const r = await migrateOne(name, { dryRun, statusOnly });
    if (!r.ok) failed = true;
    total += r.applied;
  } catch (err) {
    console.error(`  ${name}: ${err.message}`);
    failed = true;
  }
}

if (failed) {
  console.error('\nMigration did not complete. Nothing partially applied was recorded, '
    + 'so re-running after fixing the cause is safe.');
  process.exit(1);
}
if (!statusOnly && !dryRun) console.log(`\n${total} migration(s) applied.`);
