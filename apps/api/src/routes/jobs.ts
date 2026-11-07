import {
  createJobSchema,
  injectPointSchema,
  listQuerySchema,
  updateJobSchema,
} from '@fireweave/contracts';
import type { JobScheduler } from '@fireweave/queue';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@fireweave/db';
import { requestSchema } from '../docs.js';
import { errorBody } from '../http.js';
import { createJobService, JobError } from '../jobs/service.js';
import { createdAtCursorWhere, pageResult, parseListQuery, QueryError } from '../pagination.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerJobRoutes(
  scope: FastifyInstance,
  db: Database,
  queue?: JobScheduler,
): void {
  const jobs = createJobService(db, queue);

  scope.post(
    '/jobs',
    requestSchema({ tags: ['jobs'], auth: true, body: createJobSchema }),
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        return reply.code(401).send(errorBody('UNAUTHORIZED', 'Authentication required'));
      }
      try {
        const job = await jobs.create(user.id, request.body);
        return reply.code(201).send(job);
      } catch (error) {
        return sendJobError(reply, error);
      }
    },
  );

  scope.get(
    '/jobs',
    requestSchema({ tags: ['jobs'], auth: true, querystring: listQuerySchema }),
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        return reply.code(401).send(errorBody('UNAUTHORIZED', 'Authentication required'));
      }
      try {
        const query = parseListQuery(request.query);
        const rows = await db.ingestionJob.findMany({
          where: { userId: user.id, deletedAt: null, ...createdAtCursorWhere(query.cursor) },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: query.limit + 1,
        });
        const page = pageResult(rows, query.limit);
        return {
          items: page.items.map((job) => ({
            id: job.id,
            name: job.name,
            status: job.status,
            createdAt: job.createdAt.toISOString(),
            updatedAt: job.updatedAt.toISOString(),
          })),
          nextCursor: page.nextCursor,
        };
      } catch (error) {
        if (error instanceof QueryError) {
          return reply.code(400).send(errorBody('VALIDATION', error.message));
        }
        throw error;
      }
    },
  );

  scope.get(
    '/jobs/:id',
    requestSchema({ tags: ['jobs'], auth: true, params: true }),
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        return reply.code(401).send(errorBody('UNAUTHORIZED', 'Authentication required'));
      }
      try {
        return await jobs.get(user.id, routeId(request.params));
      } catch (error) {
        return sendJobError(reply, error);
      }
    },
  );

  scope.patch(
    '/jobs/:id',
    requestSchema({ tags: ['jobs'], auth: true, params: true, body: updateJobSchema }),
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        return reply.code(401).send(errorBody('UNAUTHORIZED', 'Authentication required'));
      }
      try {
        return await jobs.update(user.id, routeId(request.params), request.body);
      } catch (error) {
        return sendJobError(reply, error);
      }
    },
  );

  scope.post(
    '/jobs/:id/pause',
    requestSchema({ tags: ['jobs'], auth: true, params: true }),
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        return reply.code(401).send(errorBody('UNAUTHORIZED', 'Authentication required'));
      }
      try {
        return await jobs.pause(user.id, routeId(request.params));
      } catch (error) {
        return sendJobError(reply, error);
      }
    },
  );

  scope.post(
    '/jobs/:id/resume',
    requestSchema({ tags: ['jobs'], auth: true, params: true }),
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        return reply.code(401).send(errorBody('UNAUTHORIZED', 'Authentication required'));
      }
      try {
        return await jobs.resume(user.id, routeId(request.params));
      } catch (error) {
        return sendJobError(reply, error);
      }
    },
  );

  scope.delete(
    '/jobs/:id',
    requestSchema({ tags: ['jobs'], auth: true, params: true }),
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        return reply.code(401).send(errorBody('UNAUTHORIZED', 'Authentication required'));
      }
      try {
        await jobs.remove(user.id, routeId(request.params));
        return reply.code(204).send();
      } catch (error) {
        return sendJobError(reply, error);
      }
    },
  );

  scope.post(
    '/jobs/:id/inject',
    requestSchema({ tags: ['jobs'], auth: true, params: true, body: injectPointSchema }),
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        return reply.code(401).send(errorBody('UNAUTHORIZED', 'Authentication required'));
      }
      try {
        const accepted = await jobs.inject(user.id, routeId(request.params), request.body);
        return reply.code(202).send(accepted);
      } catch (error) {
        return sendJobError(reply, error);
      }
    },
  );
}

function routeId(params: unknown): string {
  const id = (params as { id?: unknown }).id;
  if (typeof id !== 'string' || !UUID.test(id)) {
    throw new JobError(404, 'NOT_FOUND', 'Job not found');
  }
  return id;
}

function sendJobError(
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  error: unknown,
) {
  if (error instanceof JobError) {
    return reply.code(error.statusCode).send(errorBody(error.code, error.message));
  }
  throw error;
}
