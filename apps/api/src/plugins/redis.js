/**
 * Redis plugin:
 *   fastify.redis    → general-purpose client (state cache reads, commands)
 *   fastify.redisSub → dedicated subscriber connection (pub/sub requires
 *                      its own connection in Redis).
 */
import fp from 'fastify-plugin';
import Redis from 'ioredis';

export default fp(async function redisPlugin(fastify, opts) {
  const redis = new Redis(opts.url, { lazyConnect: false, maxRetriesPerRequest: 3 });
  const redisSub = new Redis(opts.url, { lazyConnect: false, maxRetriesPerRequest: 3 });

  for (const [name, client] of [['redis', redis], ['redis-sub', redisSub]]) {
    client.on('error', (err) => fastify.log.error({ err }, `${name} connection error`));
  }

  fastify.decorate('redis', redis);
  fastify.decorate('redisSub', redisSub);

  fastify.addHook('onClose', async () => {
    await Promise.allSettled([redis.quit(), redisSub.quit()]);
  });
}, { name: 'watcher-redis' });
