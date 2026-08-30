/** Demo environment: load / clear a realistic fleet for the guided first-run. */
import { seedDemo, clearDemo, demoStatus } from './seed.js';

export default async function demoRoutes(fastify) {
  fastify.get('/status', { preHandler: fastify.requireRole('viewer') }, async (request) => {
    return demoStatus({ pg: fastify.pg, tenantId: request.user.tenantId });
  });

  fastify.post('/seed', { preHandler: fastify.requireRole('operator') }, async (request) => {
    const result = await seedDemo({
      pg: fastify.pg, tsdb: fastify.tsdb, redis: fastify.redis,
      tenantId: request.user.tenantId, log: fastify.log,
    });
    return { ok: true, ...result };
  });

  fastify.delete('/seed', { preHandler: fastify.requireRole('operator') }, async (request) => {
    const result = await clearDemo({
      pg: fastify.pg, tsdb: fastify.tsdb, redis: fastify.redis,
      tenantId: request.user.tenantId, log: fastify.log,
    });
    return { ok: true, ...result };
  });
}
