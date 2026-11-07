import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { VendorHttp, VendorRequest } from '@fireweave/core';
import { createPrismaClient } from '@fireweave/db';
import { createJobScheduler, type JobScheduler } from '@fireweave/queue';
import {
  loadWorkerConfig,
  logEvent,
  outboundLimitKey,
  registry,
  resetWorkerCounters,
  resetWorkerLog,
  runTick,
  startWorkerMetrics,
  takeToken,
  useWorkerLogStream,
  type TickContext,
} from '@fireweave/worker';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const databaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgresql://fireweave:fireweave@localhost:5432/fireweave_test';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const encryptionKey = Buffer.alloc(32, 7);
const prefix = `fwhard-${randomUUID()}`;
const secret = 'dd-secret-do-not-log-9f3a7c2e';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  ENCRYPTION_KEY: encryptionKey.toString('base64'),
  JWT_ACCESS_SECRET: 'test-access-secret-must-be-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-must-be-32-characters',
  AUTH_RATE_LIMIT_MAX: '1000',
  CORS_ORIGINS: 'https://app.example',
});

const db = createPrismaClient(databaseUrl);
const queue: JobScheduler = createJobScheduler(redisUrl, { prefix });
const calls: VendorRequest[] = [];
const http: VendorHttp = {
  async request(input) {
    calls.push(input);
    if (input.method === 'POST' && input.url.includes('api.retry.example')) {
      const attempts = calls.filter(
        (call) => call.method === 'POST' && call.url.includes('api.retry.example'),
      ).length;
      if (attempts === 1) {
        return { status: 429, body: '' };
      }
      return { status: 200, body: '{"valid":true}' };
    }
    if (input.method === 'POST' && input.url.includes('api.reject.example')) {
      return { status: 401, body: input.headers['dd-api-key'] ?? '' };
    }
    return { status: 200, body: '{"valid":true}' };
  },
};

let app: FastifyInstance;
let ipCounter = 0;

function nextIp(): string {
  ipCounter += 1;
  return `10.12.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

function tickContext(): TickContext {
  return { db, redis: queue.redis, encryptionKey, http, scheduler: queue };
}

async function signup(email: string, target = app) {
  const response = await target.inject({
    method: 'POST',
    url: '/auth/signup',
    remoteAddress: nextIp(),
    payload: { email, password: 'rK7#mQ2vLp9x' },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { accessToken: string; user: { id: string } };
}

async function account(token: string, site: string, apiKey = `dd-api-key-${site}-abcd`) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/vendor-accounts',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      vendorType: 'datadog',
      label: site,
      credentials: { apiKey, appKey: 'dd-app-key-ffffffffffffffff', site },
    },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

async function createJob(token: string, accountIds: string[]) {
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
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; status: string };
}

describe('hardening', () => {
  beforeAll(async () => {
    execSync('pnpm --filter @fireweave/db migrate:deploy', {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    });
    app = await buildApp(config, { vendorHttp: http, queue });
  });

  afterAll(async () => {
    resetWorkerLog();
    await app.close();
    await db.$disconnect();
  });

  beforeEach(async () => {
    calls.length = 0;
    resetWorkerCounters();
    resetWorkerLog();
    registry.resetMetrics();
    await queue.reset();
    const keys = await queue.redis.keys('outbound*');
    const tickKeys = await queue.redis.keys('tick:*');
    const extra = [...keys, ...tickKeys];
    if (extra.length > 0) {
      await queue.redis.del(...extra);
    }
    await db.$executeRaw`UPDATE refresh_tokens SET parent_id = NULL, replaced_by_id = NULL`;
    await db.refreshToken.deleteMany();
    await db.user.deleteMany();
  });

  it('limits authenticated requests per user', async () => {
    const limited = await buildApp(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        ENCRYPTION_KEY: encryptionKey.toString('base64'),
        JWT_ACCESS_SECRET: 'test-access-secret-must-be-32-characters',
        JWT_REFRESH_SECRET: 'test-refresh-secret-must-be-32-characters',
        AUTH_RATE_LIMIT_MAX: '1000',
        API_RATE_LIMIT_MAX: '2',
      }),
      { vendorHttp: http },
    );
    try {
      const user = await signup('limited@example.com', limited);
      const headers = { authorization: `Bearer ${user.accessToken}` };
      const first = await limited.inject({ method: 'GET', url: '/api/v1/jobs', headers });
      const second = await limited.inject({ method: 'GET', url: '/api/v1/jobs', headers });
      const third = await limited.inject({ method: 'GET', url: '/api/v1/jobs', headers });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(third.statusCode).toBe(429);
      expect(third.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    } finally {
      await limited.close();
    }
  });

  it('allows only listed CORS origins and does not serve /metrics', async () => {
    const allowed = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://app.example' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example');
    const denied = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(404);
    expect(
      loadWorkerConfig({
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        ENCRYPTION_KEY: encryptionKey.toString('base64'),
      }).metricsPort,
    ).toBe(3001);
  });

  it('publishes worker metrics on the worker port', async () => {
    const user = await signup('metrics@example.com');
    const accountId = await account(user.accessToken, 'metrics.example');
    const created = await createJob(user.accessToken, [accountId]);
    await runTick(created.id, tickContext());
    const server = await startWorkerMetrics(db, 0);
    try {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
      const body = await metrics.text();
      expect(metrics.status).toBe(200);
      expect(body).toContain('ingestion_jobs_active');
      expect(body).toContain('metrics_sent_total');
      expect(body).toContain('vendor_errors_total');
      expect(body).toContain('simulation_tick_duration_ms');
      expect(body).toContain('simulation_lag_seconds');
      expect(body).toContain('tick_deadline_exceeded_total');
      expect(body).toContain('tick_lock_lost_total');
      expect(Number(body.match(/metrics_sent_total (\d+(?:\.\d+)?)/)?.[1] ?? 0)).toBeGreaterThan(0);
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('retries a 429 and does not retry a 401', async () => {
    const user = await signup('retry@example.com');
    const retryId = await account(user.accessToken, 'retry.example', secret);
    const rejectId = await account(user.accessToken, 'reject.example', secret);
    const created = await createJob(user.accessToken, [retryId, rejectId]);
    const capture = new PassThrough();
    let logged = '';
    capture.on('data', (chunk: Buffer) => {
      logged += chunk.toString();
    });
    useWorkerLogStream(capture);
    logEvent(
      { apiKey: secret, password: secret, credentials: { token: secret, dsn: secret } },
      'failed ingest',
    );
    calls.length = 0;
    await runTick(created.id, tickContext());
    const retryPosts = calls.filter(
      (call) => call.method === 'POST' && call.url.includes('api.retry.example'),
    );
    const rejectPosts = calls.filter(
      (call) => call.method === 'POST' && call.url.includes('api.reject.example'),
    );
    expect(retryPosts).toHaveLength(2);
    expect(rejectPosts).toHaveLength(1);
    const deliveries = await db.ingestionDelivery.findMany({
      where: { batch: { jobId: created.id } },
      include: { vendorAccount: true },
    });
    const retried = deliveries.find((delivery) => delivery.vendorAccount.label === 'retry.example');
    const rejected = deliveries.find(
      (delivery) => delivery.vendorAccount.label === 'reject.example',
    );
    expect(retried?.status).toBe('delivered');
    expect(retried?.attemptCount).toBe(2);
    expect(rejected?.status).toBe('dead');
    expect(rejected?.attemptCount).toBe(1);
    expect(logged).toContain('[Redacted]');
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain('dd-app-key-ffffffffffffffff');
  });

  it('dead-letters a chunk that cannot wait for a token', async () => {
    const user = await signup('bucket@example.com');
    const accountId = await account(user.accessToken, 'bucket.example');
    const created = await createJob(user.accessToken, [accountId]);
    const spec = { capacity: 1, windowMs: 3_600_000 };
    await queue.redis.set(outboundLimitKey(accountId), `${spec.capacity},${spec.windowMs}`);
    expect(await takeToken(queue.redis, accountId, spec)).toBe(0);
    calls.length = 0;
    await runTick(created.id, tickContext());
    const delivery = await db.ingestionDelivery.findFirstOrThrow({
      where: { batch: { jobId: created.id } },
    });
    const batch = await db.ingestionBatch.findFirstOrThrow({ where: { jobId: created.id } });
    const row = await db.ingestionJob.findUniqueOrThrow({ where: { id: created.id } });
    expect(delivery.status).toBe('dead');
    expect(delivery.error).toBe('rate_limited');
    expect(batch.status).toBe('completed');
    expect(row.lastSimulatedAt?.getTime()).toBe(batch.windowEnd.getTime());
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('records signup, account, job, and auto-fail audits without secrets', async () => {
    const user = await signup('audit@example.com');
    const accountId = await account(user.accessToken, 'audit.example', secret);
    const created = await createJob(user.accessToken, [accountId]);
    let now = Date.now();
    await runTick(created.id, { ...tickContext(), now: () => new Date(now) });
    for (let lag = 0; lag < 3; lag += 1) {
      const current = await db.ingestionJob.findUniqueOrThrow({ where: { id: created.id } });
      now = (current.lastSimulatedAt?.getTime() ?? now) + 31_000;
      await queue.redis.del(`tick:${created.id}`);
      await runTick(created.id, { ...tickContext(), now: () => new Date(now) });
    }
    const rows = await db.auditLog.findMany({
      where: { userId: user.user.id },
      orderBy: { createdAt: 'asc' },
    });
    const actions = rows.map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'user.signed_up',
        'vendor_account.created',
        'job.created',
        'job.auto_failed',
      ]),
    );
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain('dd-app-key-ffffffffffffffff');
    expect(stored).not.toContain('rK7#mQ2vLp9x');
  });
});
