#!/usr/bin/env node
/**
 * Headless demo seeder: `npm run seed:demo` (or `-- --clear` to remove it).
 * Brings a fresh install to life without needing the UI or a running API.
 */
import pg from 'pg';
import Redis from 'ioredis';
import { config } from '../config.js';
import { seedDemo, clearDemo } from '../modules/demo/seed.js';

const log = {
  info: (o, m) => console.log(m ?? '', o ?? ''),
  warn: (o, m) => console.warn(m ?? '', o ?? ''),
};

const pgPool = new pg.Pool(config.pg);
const tsdbPool = new pg.Pool(config.tsdb);
const redis = new Redis(config.redisUrl);

const { rows } = await pgPool.query('SELECT id FROM tenants ORDER BY created_at LIMIT 1');
const tenantId = rows[0]?.id;
if (!tenantId) {
  console.error('No tenant found — run the database migrations/seed first.');
  process.exit(1);
}

const clear = process.argv.includes('--clear');
try {
  const fn = clear ? clearDemo : seedDemo;
  const result = await fn({ pg: pgPool, tsdb: tsdbPool, redis, tenantId, log });
  console.log(clear ? 'Demo environment cleared.' : 'Demo environment loaded.', result);
} catch (err) {
  console.error('Demo seeding failed:', err.message);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([pgPool.end(), tsdbPool.end(), redis.quit()]);
}
