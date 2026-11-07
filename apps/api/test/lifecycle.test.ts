import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { VendorHttp, VendorRequest } from '@fireweave/core';
import { createPrismaClient } from '@fireweave/db';
import { createJobScheduler, type JobScheduler } from '@fireweave/queue';
import {
  repairOnStartup,
  resetWorkerCounters,
  runTick,
  startIngestionWorker,
  workerCounters,
  type TickContext,
  type TickHooks,
  type WorkerHandle,
} from '@fireweave/worker';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const databaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgresql://fireweave:fireweave@localhost:5432/fireweave_test';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const encryptionKey = Buffer.alloc(32, 7);
const prefix = `fwtest-${randomUUID()}`;

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  ENCRYPTION_KEY: encryptionKey.toString('base64'),
  JWT_ACCESS_SECRET: 'test-access-secret-must-be-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-must-be-32-characters',
  AUTH_RATE_LIMIT_MAX: '1000',
});

const db = createPrismaClient(databaseUrl);
const queue: JobScheduler = createJobScheduler(redisUrl, { prefix });
const calls: VendorRequest[] = [];
const httpState = { hang: false };
const http: VendorHttp = {
  async request(input) {
    calls.push(input);
    if (input.signal?.aborted) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    if (httpState.hang && input.method === 'POST') {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 30_000);
        input.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          },
          { once: true },
        );
      });
    }
    if (input.method === 'POST' && input.url.includes('api.reject.example')) {
      return { status: 401, body: '' };
    }
    return { status: 200, body: '{"valid":true}' };
  },
};

const hooks: TickHooks = {};
let app: FastifyInstance;
let activeWorker: WorkerHandle | null = null;
let ipCounter = 0;

function nextIp(): string {
  ipCounter += 1;
  return `10.10.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

function tickContext(now?: () => Date): TickContext {
  return {
    db,
    redis: queue.redis,
    encryptionKey,
    http,
    scheduler: queue,
    hooks,
    ...(now ? { now } : {}),
  };
}

async function signup(email: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    remoteAddress: nextIp(),
    payload: { email, password: 'rK7#mQ2vLp9x' },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { accessToken: string; user: { id: string } };
}

async function account(token: string, site: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/vendor-accounts',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      vendorType: 'datadog',
      label: site,
      credentials: {
        apiKey: `dd-api-key-${site}-abcd`,
        appKey: 'dd-app-key-ffffffffffffffff',
        site,
      },
    },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

async function createJob(
  token: string,
  accountIds: string[],
  overrides: Record<string, unknown> = {},
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/jobs',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: 'checkout',
      timezone: 'UTC',
      virtualUserCount: 1000,
      peakRatePerSecond: 40,
      successProbability: 1,
      errorProbability: 0,
      tickIntervalMs: 1000,
      startTime: new Date().toISOString(),
      vendorAccountIds: accountIds,
      definitions: [
        { name: 'successes', type: 'counter', category: 'success', tags: { service: 'checkout' } },
        { name: 'heartbeat', type: 'gauge', category: 'dependent', dependsOn: [], formula: '1' },
      ],
      ...overrides,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as {
    id: string;
    status: string;
    definitions: Array<{ id: string; name: string }>;
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('timed out waiting for the worker');
}

describe('job lifecycle', () => {
  beforeAll(async () => {
    execSync('pnpm --filter @fireweave/db migrate:deploy', {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    });
    app = await buildApp(config, { vendorHttp: http, queue });
  });

  afterAll(async () => {
    if (activeWorker) {
      await activeWorker.shutdown();
    }
    await app.close();
    await db.$disconnect();
  });

  beforeEach(async () => {
    httpState.hang = false;
    calls.length = 0;
    hooks.afterBatchInsert = undefined;
    resetWorkerCounters();
    await queue.reset();
    const tickKeys = await queue.redis.keys('tick:*');
    const injectKeys = await queue.redis.keys('inject-rate:*');
    const keys = [...tickKeys, ...injectKeys];
    if (keys.length > 0) {
      await queue.redis.del(...keys);
    }
    await db.$executeRaw`UPDATE refresh_tokens SET parent_id = NULL, replaced_by_id = NULL`;
    await db.refreshToken.deleteMany();
    await db.user.deleteMany();
  });

  afterEach(async () => {
    if (activeWorker) {
      await activeWorker.shutdown();
      activeWorker = null;
    }
  });

  it('advances the cursor by the tick interval and starts the first window at now', async () => {
    const user = await signup('cursor@example.com');
    const accountId = await account(user.accessToken, 'cursor.example');
    const startTime = new Date(Date.now() - 60 * 60 * 1000);
    const now = new Date();
    const created = await createJob(user.accessToken, [accountId], {
      startTime: startTime.toISOString(),
      tickIntervalMs: 5000,
    });
    await runTick(
      created.id,
      tickContext(() => now),
    );
    const batch = await db.ingestionBatch.findFirstOrThrow({ where: { jobId: created.id } });
    const row = await db.ingestionJob.findUniqueOrThrow({ where: { id: created.id } });
    expect(batch.windowStart.getTime()).toBe(now.getTime());
    expect(batch.windowStart.getTime()).not.toBe(startTime.getTime());
    expect(row.lastSimulatedAt?.getTime()).toBe(now.getTime() + 5000);
    expect(batch.status).toBe('completed');
  });

  it('abandons a batch when pause lands before the send and leaves the cursor', async () => {
    const user = await signup('pause-window@example.com');
    const accountId = await account(user.accessToken, 'pause-window.example');
    const created = await createJob(user.accessToken, [accountId]);
    hooks.afterBatchInsert = async () => {
      const paused = await app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${created.id}/pause`,
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      expect(paused.statusCode).toBe(200);
    };
    await runTick(created.id, tickContext());
    const batch = await db.ingestionBatch.findFirstOrThrow({ where: { jobId: created.id } });
    const row = await db.ingestionJob.findUniqueOrThrow({ where: { id: created.id } });
    expect(batch.status).toBe('abandoned');
    expect(row.lastSimulatedAt).toBeNull();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('does not create a second batch for a window abandoned at startup', async () => {
    const user = await signup('crash@example.com');
    const accountId = await account(user.accessToken, 'crash.example');
    const created = await createJob(user.accessToken, [accountId]);
    hooks.afterBatchInsert = async () => {
      throw new Error('crash');
    };
    await expect(runTick(created.id, tickContext())).rejects.toThrow('crash');
    const crashed = await db.ingestionBatch.findFirstOrThrow({ where: { jobId: created.id } });
    expect(crashed.status).toBe('in_flight');
    await db.ingestionBatch.update({
      where: { id: crashed.id },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });
    await repairOnStartup(db);
    const abandoned = await db.ingestionBatch.findUniqueOrThrow({ where: { id: crashed.id } });
    const repaired = await db.ingestionJob.findUniqueOrThrow({ where: { id: created.id } });
    expect(abandoned.status).toBe('abandoned');
    expect(repaired.lastSimulatedAt?.getTime()).toBe(abandoned.windowEnd.getTime());

    hooks.afterBatchInsert = undefined;
    await queue.redis.del(`tick:${created.id}`);
    await runTick(created.id, tickContext());
    const sameWindow = await db.ingestionBatch.count({
      where: { jobId: created.id, windowStart: abandoned.windowStart },
    });
    expect(sameWindow).toBe(1);
    const batches = await db.ingestionBatch.findMany({ where: { jobId: created.id } });
    expect(batches).toHaveLength(2);
    expect(new Set(batches.map((batch) => batch.windowStart.toISOString())).size).toBe(2);
  });

  it('dead-letters one rejected account and still advances the cursor', async () => {
    const user = await signup('fanout@example.com');
    const ids = await Promise.all([
      account(user.accessToken, 'ok-a.example'),
      account(user.accessToken, 'reject.example'),
      account(user.accessToken, 'ok-b.example'),
    ]);
    const created = await createJob(user.accessToken, ids);
    await runTick(created.id, tickContext());
    const deliveries = await db.ingestionDelivery.findMany({
      where: { batch: { jobId: created.id } },
      include: { vendorAccount: true },
    });
    expect(deliveries.filter((delivery) => delivery.status === 'delivered')).toHaveLength(2);
    expect(deliveries.filter((delivery) => delivery.status === 'dead')).toHaveLength(1);
    const rejected = deliveries.find(
      (delivery) => delivery.vendorAccount.label === 'reject.example',
    );
    expect(rejected?.status).toBe('dead');
    const row = await db.ingestionJob.findUniqueOrThrow({ where: { id: created.id } });
    const batch = await db.ingestionBatch.findFirstOrThrow({ where: { jobId: created.id } });
    expect(batch.status).toBe('completed');
    expect(row.lastSimulatedAt?.getTime()).toBe(batch.windowEnd.getTime());
  });

  it('dead-letters a hung vendor at the deadline and counts it', async () => {
    const user = await signup('deadline@example.com');
    const accountId = await account(user.accessToken, 'deadline.example');
    const created = await createJob(user.accessToken, [accountId]);
    httpState.hang = true;
    await runTick(created.id, tickContext());
    const delivery = await db.ingestionDelivery.findFirstOrThrow({
      where: { batch: { jobId: created.id } },
    });
    const batch = await db.ingestionBatch.findFirstOrThrow({ where: { jobId: created.id } });
    const row = await db.ingestionJob.findUniqueOrThrow({ where: { id: created.id } });
    expect(delivery.status).toBe('dead');
    expect(delivery.error).toBe('tick_deadline');
    expect(batch.status).toBe('completed');
    expect(row.lastSimulatedAt?.getTime()).toBe(batch.windowEnd.getTime());
    expect(workerCounters.tick_deadline_exceeded_total).toBe(1);
  });

  it('releases the tick lock when the worker shuts down during a tick', async () => {
    const user = await signup('shutdown@example.com');
    const accountId = await account(user.accessToken, 'shutdown.example');
    httpState.hang = true;
    activeWorker = await startIngestionWorker({
      redisUrl,
      prefix,
      db,
      encryptionKey,
      http,
      scheduler: queue,
      concurrency: 1,
    });
    const created = await createJob(user.accessToken, [accountId]);
    await waitFor(async () => (await queue.redis.get(`tick:${created.id}`)) !== null);
    await activeWorker.shutdown();
    activeWorker = null;
    expect(await queue.redis.get(`tick:${created.id}`)).toBeNull();
  });

  it('fails a job after three lagging ticks and removes its repeatable', async () => {
    const user = await signup('lag@example.com');
    const accountId = await account(user.accessToken, 'lag.example');
    const created = await createJob(user.accessToken, [accountId]);
    let now = Date.now();
    await runTick(
      created.id,
      tickContext(() => new Date(now)),
    );
    for (let lag = 0; lag < 3; lag += 1) {
      const current = await db.ingestionJob.findUniqueOrThrow({ where: { id: created.id } });
      now = (current.lastSimulatedAt?.getTime() ?? now) + 31_000;
      await queue.redis.del(`tick:${created.id}`);
      await runTick(
        created.id,
        tickContext(() => new Date(now)),
      );
    }
    const row = await db.ingestionJob.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe('failed');
    expect(row.consecutiveLagTicks).toBe(3);
    const repeatables = await queue.listRepeatables();
    expect(repeatables.some((job) => job.id === created.id)).toBe(false);
  });

  it('walks a tick, pause, inject, resume without backfill, and delete', async () => {
    const user = await signup('control@example.com');
    const accountId = await account(user.accessToken, 'control.example');
    activeWorker = await startIngestionWorker({
      redisUrl,
      prefix,
      db,
      encryptionKey,
      http,
      scheduler: queue,
      concurrency: 1,
    });
    const created = await createJob(user.accessToken, [accountId]);
    await waitFor(
      async () =>
        (await db.ingestionBatch.count({ where: { jobId: created.id, status: 'completed' } })) >= 1,
    );
    const first = await db.ingestionBatch.findFirstOrThrow({ where: { jobId: created.id } });
    const cursor = await db.ingestionJob.findUniqueOrThrow({ where: { id: created.id } });
    expect(cursor.lastSimulatedAt?.getTime()).toBe(first.windowEnd.getTime());
    expect(first.windowEnd.getTime() - first.windowStart.getTime()).toBe(1000);

    const paused = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${created.id}/pause`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(paused.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const whilePaused = await db.ingestionBatch.count({ where: { jobId: created.id } });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await db.ingestionBatch.count({ where: { jobId: created.id } })).toBe(whilePaused);

    const beforeInject = await db.ingestionJob.findUniqueOrThrow({ where: { id: created.id } });
    calls.length = 0;
    const injected = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${created.id}/inject`,
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { metricDefinitionId: created.definitions[0]?.id, value: 42.5 },
    });
    expect(injected.statusCode).toBe(202);
    await waitFor(async () =>
      calls.some((call) => call.method === 'POST' && call.body?.includes('42.5')),
    );
    const afterInject = await db.ingestionJob.findUniqueOrThrow({ where: { id: created.id } });
    expect(afterInject.lastSimulatedAt?.getTime() ?? null).toBe(
      beforeInject.lastSimulatedAt?.getTime() ?? null,
    );
    expect(await db.ingestionBatch.count({ where: { jobId: created.id } })).toBe(whilePaused);

    const beforeResume = await db.ingestionJob.findUniqueOrThrow({ where: { id: created.id } });
    const resumed = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${created.id}/resume`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(resumed.statusCode).toBe(200);
    await waitFor(async () => {
      const next = await db.ingestionBatch.findFirst({
        where: {
          jobId: created.id,
          windowStart: { gt: beforeResume.lastSimulatedAt ?? new Date(0) },
        },
      });
      return next !== null;
    });
    const next = await db.ingestionBatch.findFirstOrThrow({
      where: {
        jobId: created.id,
        windowStart: { gt: beforeResume.lastSimulatedAt ?? new Date(0) },
      },
      orderBy: { windowStart: 'asc' },
    });
    expect(next.windowStart.getTime()).toBeGreaterThan(
      (beforeResume.lastSimulatedAt?.getTime() ?? 0) + 1000,
    );

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/jobs/${created.id}`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(removed.statusCode).toBe(204);
    expect((await queue.listRepeatables()).some((job) => job.id === created.id)).toBe(false);
    const row = await db.ingestionJob.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.deletedAt).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterDelete = await db.ingestionBatch.count({ where: { jobId: created.id } });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(await db.ingestionBatch.count({ where: { jobId: created.id } })).toBe(afterDelete);
  });

  it('keeps a future job scheduled until its starter runs', async () => {
    const user = await signup('scheduled@example.com');
    const accountId = await account(user.accessToken, 'scheduled.example');
    const startTime = new Date(Date.now() + 2_000);
    const created = await createJob(user.accessToken, [accountId], {
      startTime: startTime.toISOString(),
    });
    expect(created.status).toBe('scheduled');
    expect(await queue.listRepeatables()).toEqual([]);
    activeWorker = await startIngestionWorker({
      redisUrl,
      prefix,
      db,
      encryptionKey,
      http,
      scheduler: queue,
      concurrency: 1,
    });
    await waitFor(async () => {
      const row = await db.ingestionJob.findUnique({ where: { id: created.id } });
      return row?.status === 'active';
    });
    await waitFor(
      async () =>
        (await db.ingestionBatch.count({ where: { jobId: created.id, status: 'completed' } })) >= 1,
    );
    const batch = await db.ingestionBatch.findFirstOrThrow({ where: { jobId: created.id } });
    expect(batch.windowStart.getTime()).toBeGreaterThanOrEqual(startTime.getTime() - 50);
  });

  it('injects one point without moving the cursor', async () => {
    const user = await signup('inject@example.com');
    const accountId = await account(user.accessToken, 'inject.example');
    const created = await createJob(user.accessToken, [accountId]);
    const paused = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${created.id}/pause`,
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(paused.statusCode).toBe(200);
    const before = await db.ingestionJob.findUniqueOrThrow({ where: { id: created.id } });
    activeWorker = await startIngestionWorker({
      redisUrl,
      prefix,
      db,
      encryptionKey,
      http,
      scheduler: queue,
      concurrency: 1,
    });
    calls.length = 0;
    const injected = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${created.id}/inject`,
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { metricDefinitionId: created.definitions[0]?.id, value: 42 },
    });
    expect(injected.statusCode).toBe(202);
    await waitFor(async () =>
      calls.some((call) => call.method === 'POST' && call.body?.includes('42')),
    );
    const after = await db.ingestionJob.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.lastSimulatedAt?.getTime() ?? null).toBe(
      before.lastSimulatedAt?.getTime() ?? null,
    );
    expect(await db.ingestionBatch.count({ where: { jobId: created.id } })).toBe(0);
  });
});
