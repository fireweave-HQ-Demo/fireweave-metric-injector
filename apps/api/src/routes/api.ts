import type { VendorHttp } from '@fireweave/core';
import type { Database } from '@fireweave/db';
import type { JobScheduler } from '@fireweave/queue';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { requireAccessToken } from '../auth/guard.js';
import { registerJobRoutes } from './jobs.js';
import { registerVendorRoutes } from './vendors.js';

export async function registerProtectedRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    accessSecret: string;
    encryptionKey: Buffer;
    apiRateLimitMax: number;
    http?: VendorHttp;
    queue?: JobScheduler;
  },
): Promise<void> {
  await app.register(
    async (scope) => {
      scope.addHook('onRequest', requireAccessToken(deps.accessSecret));
      await scope.register(rateLimit, {
        max: deps.apiRateLimitMax,
        timeWindow: '1 minute',
        keyGenerator: (request) => request.user?.id ?? request.ip,
        errorResponseBuilder: (_request, context) => {
          const error = new Error('Too many requests') as Error & { statusCode: number };
          error.statusCode = context.statusCode;
          return error;
        },
      });
      registerJobRoutes(scope, deps.db, deps.queue);
      registerVendorRoutes(scope, deps);
    },
    { prefix: '/api/v1' },
  );
}
