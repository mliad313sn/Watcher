/**
 * Database plugin: two pools —
 *   fastify.pg    → PostgreSQL config plane (tenants, devices, alerts…)
 *   fastify.tsdb  → TimescaleDB metrics store
 */
import fp from 'fastify-plugin';
import pg from 'pg';

export default fp(async function dbPlugin(fastify, opts) {
  const pgPool = new pg.Pool(opts.pg);
  const tsdbPool = new pg.Pool(opts.tsdb);

  pgPool.on('error', (err) => fastify.log.error({ err }, 'postgres pool error'));
  tsdbPool.on('error', (err) => fastify.log.error({ err }, 'timescaledb pool error'));

  fastify.decorate('pg', pgPool);
  fastify.decorate('tsdb', tsdbPool);

  fastify.addHook('onClose', async () => {
    await Promise.allSettled([pgPool.end(), tsdbPool.end()]);
  });
}, { name: 'watcher-db' });
