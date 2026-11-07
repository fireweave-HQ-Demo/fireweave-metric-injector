import {
  createVendorAccountSchema,
  listQuerySchema,
  updateVendorAccountSchema,
} from '@fireweave/contracts';
import type { FastifyInstance } from 'fastify';
import { requestSchema } from '../docs.js';
import { errorBody } from '../http.js';
import { parseListQuery, QueryError } from '../pagination.js';
import { AccountError, createVendorService } from '../vendors/accounts.js';
import type { VendorHttp } from '@fireweave/core';
import type { Database } from '@fireweave/db';

export function registerVendorRoutes(
  scope: FastifyInstance,
  deps: { db: Database; encryptionKey: Buffer; http?: VendorHttp },
): void {
  const accounts = createVendorService(deps);

  scope.post(
    '/vendor-accounts',
    requestSchema({ tags: ['vendor-accounts'], auth: true, body: createVendorAccountSchema }),
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        return reply.code(401).send(errorBody('UNAUTHORIZED', 'Authentication required'));
      }
      try {
        const account = await accounts.create(user.id, request.body);
        return reply.code(201).send(account);
      } catch (error) {
        return sendAccountError(reply, error);
      }
    },
  );

  scope.get(
    '/vendor-accounts',
    requestSchema({ tags: ['vendor-accounts'], auth: true, querystring: listQuerySchema }),
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        return reply.code(401).send(errorBody('UNAUTHORIZED', 'Authentication required'));
      }
      try {
        return await accounts.list(user.id, parseListQuery(request.query));
      } catch (error) {
        return sendAccountError(reply, error);
      }
    },
  );

  scope.patch(
    '/vendor-accounts/:id',
    requestSchema({
      tags: ['vendor-accounts'],
      auth: true,
      params: true,
      body: updateVendorAccountSchema,
    }),
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        return reply.code(401).send(errorBody('UNAUTHORIZED', 'Authentication required'));
      }
      try {
        return await accounts.update(user.id, routeId(request.params), request.body);
      } catch (error) {
        return sendAccountError(reply, error);
      }
    },
  );

  scope.delete(
    '/vendor-accounts/:id',
    requestSchema({ tags: ['vendor-accounts'], auth: true, params: true }),
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        return reply.code(401).send(errorBody('UNAUTHORIZED', 'Authentication required'));
      }
      try {
        await accounts.remove(user.id, routeId(request.params));
        return reply.code(204).send();
      } catch (error) {
        return sendAccountError(reply, error);
      }
    },
  );

  scope.post(
    '/vendor-accounts/:id/validate',
    requestSchema({ tags: ['vendor-accounts'], auth: true, params: true }),
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        return reply.code(401).send(errorBody('UNAUTHORIZED', 'Authentication required'));
      }
      try {
        return await accounts.revalidate(user.id, routeId(request.params));
      } catch (error) {
        return sendAccountError(reply, error);
      }
    },
  );
}

function routeId(params: unknown): string {
  const id = (params as { id?: unknown }).id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new AccountError(400, 'VALIDATION', 'Invalid request');
  }
  return id;
}

function sendAccountError(
  reply: { code: (status: number) => { send: (body: unknown) => unknown } },
  error: unknown,
) {
  if (error instanceof AccountError || error instanceof QueryError) {
    const statusCode = error instanceof AccountError ? error.statusCode : 400;
    const code = error instanceof AccountError ? error.code : 'VALIDATION';
    return reply.code(statusCode).send(errorBody(code, error.message));
  }
  throw error;
}
