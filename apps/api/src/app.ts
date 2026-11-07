import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { createPrismaClient, type Database } from '@fireweave/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { logRedact, type VendorHttp } from '@fireweave/core';
import type { JobScheduler } from '@fireweave/queue';
import { hashPassword, loadDenylist } from './auth/passwords.js';
import { loadConfig, type Config } from './config.js';
import { errorBody } from './http.js';
import { registerDocs } from './docs.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerProtectedRoutes } from './routes/api.js';
import { registerHealthRoutes } from './routes/health.js';

export type BuildAppOptions = {
  vendorHttp?: VendorHttp;
  queue?: JobScheduler;
};

export async function buildApp(
  config: Config,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const db = createPrismaClient(config.databaseUrl);
  const denylist = loadDenylist(config.passwordDenylistPath);
  const dummyPasswordHash = await hashPassword(randomBytes(32).toString('hex'));
  const app = Fastify({
    logger: {
      level: config.nodeEnv === 'development' ? 'info' : 'silent',
      redact: logRedact,
    },
    genReqId: () => randomUUID(),
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'request failed');
    const statusCode =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    if (statusCode === 429) {
      return reply.code(429).send(errorBody('RATE_LIMITED', 'Too many requests'));
    }
    if (statusCode >= 500) {
      return reply.code(statusCode).send(errorBody('INTERNAL', 'Internal server error'));
    }
    const message = error instanceof Error ? error.message : 'Request failed';
    return reply.code(statusCode).send(errorBody('REQUEST_FAILED', message));
  });

  await registerDocs(app);
  await app.register(cookie);
  if (config.corsOrigins.length > 0) {
    await app.register(cors, { origin: config.corsOrigins, credentials: true });
  }
  await registerHealthRoutes(app, db);
  await registerAuthRoutes(app, { db, config, denylist, dummyPasswordHash });
  await registerProtectedRoutes(app, {
    db,
    accessSecret: config.jwtAccessSecret,
    encryptionKey: config.encryptionKey,
    apiRateLimitMax: config.apiRateLimitMax,
    ...(options.vendorHttp ? { http: options.vendorHttp } : {}),
    ...(options.queue ? { queue: options.queue } : {}),
  });

  app.addHook('onClose', async () => {
    await db.$disconnect();
    await options.queue?.close();
  });

  return app;
}

export async function buildAppFromEnv(
  source: Record<string, string | undefined>,
): Promise<FastifyInstance> {
  return buildApp(loadConfig(source));
}

export type { Database };
