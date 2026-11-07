import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createFetchHttp, createVendorAdapter, normalizeVendorCredentials } from '@fireweave/core';
import { createPrismaClient } from '@fireweave/db';
import { createJobScheduler, type JobScheduler } from '@fireweave/queue';
import { startIngestionWorker, type WorkerHandle } from '@fireweave/worker';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const email = process.env.OPENOBSERVE_EMAIL?.trim() ?? '';
const baseUrl = process.env.OPENOBSERVE_BASE_URL?.trim() || 'https://api.openobserve.ai';
const orgs = [
  {
    name: 'staging',
    organization: process.env.OPENOBSERVE_STAGING_ORG?.trim() ?? '',
    password: process.env.OPENOBSERVE_STAGING_PASSWORD ?? '',
  },
  {
    name: 'production',
    organization: process.env.OPENOBSERVE_PRODUCTION_ORG?.trim() ?? '',
    password: process.env.OPENOBSERVE_PRODUCTION_PASSWORD ?? '',
  },
];
const configured = email.includes('@') && orgs.every((org) => org.organization && org.password);

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const databaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgresql://fireweave:fireweave@localhost:5432/fireweave_test';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const encryptionKey = Buffer.alloc(32, 7);
const http = createFetchHttp();
const runId = `fw_live_${Date.now()}`;

type Sample = { value: string; labels: Record<string, string> };

describe.skipIf(!configured)('openobserve live', () => {
  const appHolder: { app?: FastifyInstance; worker?: WorkerHandle; queue?: JobScheduler } = {};
  const db = createPrismaClient(databaseUrl);
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    ENCRYPTION_KEY: encryptionKey.toString('base64'),
    JWT_ACCESS_SECRET: 'test-access-secret-must-be-32-characters',
    JWT_REFRESH_SECRET: 'test-refresh-secret-must-be-32-characters',
    AUTH_RATE_LIMIT_MAX: '1000',
  });

  afterAll(async () => {
    await appHolder.worker?.shutdown();
    await appHolder.app?.close();
    await db.user.deleteMany({ where: { email: 'openobserve-live@example.com' } });
    await db.$disconnect();
  });

  it('accepts the real password and rejects a wrong one on both orgs', async () => {
    for (const org of orgs) {
      const adapter = adapterFor(org.organization, org.password);
      await expect(adapter.validateCredentials()).resolves.toBe(true);
      await expect(
        adapterFor(org.organization, 'wrong-password-value').validateCredentials(),
      ).resolves.toBe(false);
    }
    await expect(
      adapterFor('missingorg000000000000000', orgs[0]?.password ?? '').validateCredentials(),
    ).resolves.toBe(false);
  });

  it('ingests counter, gauge, histogram, zero, negative, and a dotted name', async () => {
    for (const org of orgs) {
      const adapter = adapterFor(org.organization, org.password);
      const stamp = Date.now();
      const names = {
        counter: `${runId}_${org.name}_counter`,
        gauge: `${runId}_${org.name}_gauge`,
        histogram: `${runId}_${org.name}_histogram`,
        zero: `${runId}_${org.name}_zero`,
        negative: `${runId}_${org.name}_negative`,
        dotted: `${runId}.${org.name}.orders.completed`,
      };
      const sent = await adapter.ingestMetrics(
        [
          point(names.counter, 'counter', 3, stamp, { service: 'checkout', env: org.name }),
          point(names.gauge, 'gauge', 42.5, stamp, { service: 'checkout' }),
          point(names.histogram, 'histogram', 12.5, stamp, { service: 'checkout' }),
          point(names.zero, 'gauge', 0, stamp, {}),
          point(names.negative, 'gauge', -7, stamp, {}),
          point(names.dotted, 'counter', 9, stamp, { service: 'checkout' }),
        ],
        { batchId: randomUUID() },
      );
      expect(sent).toMatchObject({ ok: true, acceptedCount: 6 });

      await expect(sample(org, names.counter)).resolves.toMatchObject({
        value: '3',
        labels: { service: 'checkout', env: org.name },
      });
      await expect(sample(org, names.gauge)).resolves.toMatchObject({ value: '42.5' });
      await expect(sample(org, names.histogram)).resolves.toMatchObject({ value: '12.5' });
      await expect(sample(org, names.zero)).resolves.toMatchObject({ value: '0' });
      await expect(sample(org, names.negative)).resolves.toMatchObject({ value: '-7' });
      await expect(sample(org, names.dotted.replaceAll('.', '_'))).resolves.toMatchObject({
        value: '9',
        labels: { service: 'checkout' },
      });
    }
  });

  it('rejects an ingest with a bad password', async () => {
    const org = orgs[0];
    if (!org) {
      throw new Error('missing org');
    }
    const sent = await adapterFor(org.organization, 'wrong-password-value').ingestMetrics(
      [point(`${runId}_denied`, 'counter', 1, Date.now(), {})],
      { batchId: randomUUID() },
    );
    expect(sent.ok).toBe(false);
    expect(sent.statusCode).toBe(401);
  });

  it('stores an account, injects each type through the worker, and reads the points back', async () => {
    execSync('pnpm --filter @fireweave/db migrate:deploy', {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    });
    const queue = createJobScheduler(redisUrl, { prefix: `fwlive-${randomUUID()}` });
    appHolder.queue = queue;
    const app = await buildApp(config, { queue });
    appHolder.app = app;
    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      remoteAddress: '10.88.0.8',
      payload: { email: 'openobserve-live@example.com', password: 'rK7#mQ2vLp9x' },
    });
    expect(signup.statusCode).toBe(201);
    const token = (signup.json() as { accessToken: string }).accessToken;
    const worker = await startIngestionWorker({
      redisUrl,
      prefix: queue.prefix,
      db,
      encryptionKey,
      http,
      scheduler: queue,
      concurrency: 1,
    });
    appHolder.worker = worker;

    for (const org of orgs) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/vendor-accounts',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          vendorType: 'openobserve',
          label: org.name,
          credentials: {
            baseUrl,
            organization: org.organization,
            email,
            password: org.password,
          },
        },
      });
      expect(created.statusCode).toBe(201);
      const account = created.json() as {
        id: string;
        credentialKind: string;
        credentialHint: string;
      };
      expect(account.credentialKind).toBe('email');
      expect(account.credentialHint).toBe(email.slice(-4));
      expect(JSON.stringify(created.json())).not.toContain(org.password);

      const rejected = await app.inject({
        method: 'POST',
        url: '/api/v1/vendor-accounts',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          vendorType: 'openobserve',
          label: `${org.name}-bad`,
          credentials: {
            baseUrl,
            organization: org.organization,
            email,
            password: 'wrong-password-value',
          },
        },
      });
      expect(rejected.statusCode).toBe(422);
      expect(JSON.stringify(rejected.json())).not.toContain(org.password);

      const checked = await app.inject({
        method: 'POST',
        url: `/api/v1/vendor-accounts/${account.id}/validate`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(checked.statusCode).toBe(200);

      const suffix = `${runId}_${org.name}_tool`;
      const jobResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: `${org.name} live`,
          timezone: 'UTC',
          virtualUserCount: 10,
          peakRatePerSecond: 1,
          successProbability: 1,
          errorProbability: 0,
          tickIntervalMs: 1000,
          startTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          vendorAccountIds: [account.id],
          definitions: [
            {
              name: `${suffix}_counter`,
              type: 'counter',
              category: 'custom',
              tags: { source: 'fireweave' },
            },
            {
              name: `${suffix}_gauge`,
              type: 'gauge',
              category: 'custom',
              tags: { source: 'fireweave' },
            },
            {
              name: `${suffix}_histogram`,
              type: 'histogram',
              category: 'custom',
              tags: { source: 'fireweave' },
            },
            {
              name: `${suffix}_dependent`,
              type: 'gauge',
              category: 'dependent',
              dependsOn: [`${suffix}_gauge`],
              formula: `${suffix}_gauge`,
              tags: { source: 'fireweave' },
            },
          ],
        },
      });
      expect(jobResponse.statusCode).toBe(201);
      const job = jobResponse.json() as {
        id: string;
        status: string;
        definitions: Array<{ id: string; name: string }>;
      };
      expect(job.status).toBe('scheduled');
      const paused = await app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${job.id}/pause`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(paused.statusCode).toBe(200);

      const injected = [
        { name: `${suffix}_counter`, value: 3 },
        { name: `${suffix}_gauge`, value: 42.5 },
        { name: `${suffix}_histogram`, value: 12.5 },
      ];
      for (const metric of injected) {
        const definition = job.definitions.find((item) => item.name === metric.name);
        const response = await app.inject({
          method: 'POST',
          url: `/api/v1/jobs/${job.id}/inject`,
          headers: { authorization: `Bearer ${token}` },
          payload: { metricDefinitionId: definition?.id, value: metric.value },
        });
        expect(response.statusCode).toBe(202);
      }
      await expect(sample(org, `${suffix}_counter`)).resolves.toMatchObject({
        value: '3',
        labels: { source: 'fireweave' },
      });
      await expect(sample(org, `${suffix}_gauge`)).resolves.toMatchObject({ value: '42.5' });
      await expect(sample(org, `${suffix}_histogram`)).resolves.toMatchObject({ value: '12.5' });

      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/v1/jobs/${job.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(removed.statusCode).toBe(204);
      const deletedAccount = await app.inject({
        method: 'DELETE',
        url: `/api/v1/vendor-accounts/${account.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(deletedAccount.statusCode).toBe(204);
    }
  });
});

function adapterFor(organization: string, password: string) {
  return createVendorAdapter({
    accountId: 'live',
    credentials: normalizeVendorCredentials({
      vendorType: 'openobserve',
      credentials: { baseUrl, organization, email, password },
    }),
    http,
  });
}

function point(
  name: string,
  type: 'counter' | 'gauge' | 'histogram',
  value: number,
  timestamp: number,
  tags: Record<string, string>,
) {
  return { name, type, value, timestamp: new Date(timestamp), tags };
}

async function sample(
  org: { organization: string; password: string },
  name: string,
): Promise<Sample> {
  const started = Date.now();
  let latest = '';
  while (Date.now() - started < 15_000) {
    const response = await fetch(
      `${baseUrl}/api/${encodeURIComponent(org.organization)}/prometheus/api/v1/query?query=${encodeURIComponent(name)}`,
      {
        headers: {
          authorization: `Basic ${Buffer.from(`${email}:${org.password}`).toString('base64')}`,
        },
      },
    );
    latest = await response.text();
    const parsed = JSON.parse(latest) as {
      data?: { result?: Array<{ metric?: Record<string, string>; value?: [number, string] }> };
    };
    const hit = parsed.data?.result?.find((row) => row.metric?.__name__ === name);
    const value = hit?.value?.[1];
    if (hit?.metric && value !== undefined) {
      const labels = { ...hit.metric };
      delete labels.__name__;
      return { value, labels };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`metric ${name} was not queryable: ${latest.slice(0, 300)}`);
}
