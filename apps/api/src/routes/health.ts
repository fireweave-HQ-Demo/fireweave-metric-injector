import type { FastifyInstance } from 'fastify';
import type { Database } from '@fireweave/db';
import { requestSchema } from '../docs.js';

export async function registerHealthRoutes(app: FastifyInstance, db: Database): Promise<void> {
  app.get('/health', requestSchema({ tags: ['health'] }), async (_request, reply) => {
    try {
      await db.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'degraded' });
    }
  });
}
