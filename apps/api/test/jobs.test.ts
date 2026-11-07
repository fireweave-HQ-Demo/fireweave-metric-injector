import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPrismaClient } from '@fireweave/db';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const databaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgresql://fireweave:fireweave@localhost:5432/fireweave_test';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  JWT_ACCESS_SECRET: 'test-access-secret-must-be-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-must-be-32-characters',
  AUTH_RATE_LIMIT_MAX: '1000',
});

const db = createPrismaClient(databaseUrl);
let app: FastifyInstance;
let ipCounter = 0;

function nextIp(): string {
  ipCounter += 1;
  return `10.9.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
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

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

function metric(overrides: Record<string, unknown>) {
  return {
    type: 'counter',
    category: 'success',
    tags: {},
    dependsOn: [],
    formula: null,
    ...overrides,
  };
}

function jobBody(
  accountId: string,
  definitions: unknown[],
  startTime = '2099-01-02T00:00:00.000Z',
) {
  return {
    name: 'checkout',
    timezone: 'UTC',
    virtualUserCount: 1000,
    peakRatePerSecond: 5,
    successProbability: 0.9,
    errorProbability: 0.05,
    startTime,
    vendorAccountIds: [accountId],
    definitions,
  };
}

const rate = metric({
  name: 'error_rate',
  type: 'gauge',
  category: 'dependent',
  dependsOn: ['errors', 'successes'],
  formula: 'errors / (successes + errors)',
});

describe('jobs and metric definitions', () => {
  beforeAll(async () => {
    execSync('pnpm --filter @fireweave/db migrate:deploy', {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    });
    app = await buildApp(config);
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.$executeRaw`UPDATE refresh_tokens SET parent_id = NULL, replaced_by_id = NULL`;
    await db.refreshToken.deleteMany();
    await db.user.deleteMany();
  });

  async function accountFor(userId: string) {
    const account = await db.vendorAccount.create({
      data: {
        userId,
        vendorType: 'datadog',
        label: 'dd',
        credentialsCipher: new Uint8Array([1, 2, 3, 4]),
        credentialHint: 'abcd',
        credentialKind: 'api_key',
        validatedAt: new Date(),
      },
    });
    return account.id;
  }

  it('rejects a cycle and stores nothing', async () => {
    const user = await signup('cycle@example.com');
    const accountId = await accountFor(user.user.id);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      headers: auth(user.accessToken),
      payload: jobBody(accountId, [
        metric({ name: 'a', type: 'gauge', category: 'dependent', dependsOn: ['b'], formula: 'b' }),
        metric({ name: 'b', type: 'gauge', category: 'dependent', dependsOn: ['a'], formula: 'a' }),
      ]),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION' } });
    expect(JSON.stringify(response.json())).toMatch(/cycle/);
    expect(await db.ingestionJob.count()).toBe(0);
    expect(await db.metricDefinition.count()).toBe(0);
  });

  it('saves evalOrder so dependencies come after their inputs', async () => {
    const user = await signup('order@example.com');
    const accountId = await accountFor(user.user.id);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      headers: auth(user.accessToken),
      payload: jobBody(accountId, [
        rate,
        metric({ name: 'successes', category: 'success', tags: { service: 'checkout' } }),
        metric({ name: 'errors', category: 'error' }),
      ]),
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      id: string;
      status: string;
      definitions: Array<{ name: string; evalOrder: number }>;
    };
    expect(body.status).toBe('scheduled');
    const order = Object.fromEntries(
      body.definitions.map((definition) => [definition.name, definition.evalOrder]),
    );
    expect(order.error_rate).toBeGreaterThan(order.successes ?? 0);
    expect(order.error_rate).toBeGreaterThan(order.errors ?? 0);
    expect(body.definitions.map((definition) => definition.evalOrder)).toEqual([0, 1, 2]);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${body.id}`,
      headers: auth(user.accessToken),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      definitions: body.definitions.map((definition) => ({
        name: definition.name,
        evalOrder: definition.evalOrder,
      })),
      failures: [],
      lastSimulatedAt: null,
    });
  });

  it('replaces the definition set unless the job is active', async () => {
    const user = await signup('replace-metrics@example.com');
    const other = await signup('other-metrics@example.com');
    const accountId = await accountFor(user.user.id);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      headers: auth(user.accessToken),
      payload: jobBody(accountId, [
        metric({ name: 'successes', category: 'success' }),
        metric({ name: 'errors', category: 'error' }),
      ]),
    });
    const job = created.json() as { id: string };
    const replaced = await app.inject({
      method: 'PATCH',
      url: `/api/v1/jobs/${job.id}`,
      headers: auth(user.accessToken),
      payload: { definitions: [metric({ name: 'successes', category: 'success' })] },
    });
    expect(replaced.statusCode).toBe(200);
    expect(
      (replaced.json() as { definitions: Array<{ name: string }> }).definitions.map(
        (item) => item.name,
      ),
    ).toEqual(['successes']);
    expect(await db.metricDefinition.count({ where: { jobId: job.id } })).toBe(1);

    const active = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      headers: auth(user.accessToken),
      payload: jobBody(
        accountId,
        [
          metric({ name: 'successes', category: 'success' }),
          metric({ name: 'errors', category: 'error' }),
        ],
        '2020-01-02T00:00:00.000Z',
      ),
    });
    const running = active.json() as { id: string; status: string };
    expect(running.status).toBe('active');
    const blocked = await app.inject({
      method: 'PATCH',
      url: `/api/v1/jobs/${running.id}`,
      headers: auth(user.accessToken),
      payload: { definitions: [metric({ name: 'successes', category: 'success' })] },
    });
    expect(blocked.statusCode).toBe(409);
    expect(await db.metricDefinition.count({ where: { jobId: running.id } })).toBe(2);

    const hidden = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${job.id}`,
      headers: auth(other.accessToken),
    });
    expect(hidden.statusCode).toBe(404);
  });

  it('rejects an invalid tag or formula before writing', async () => {
    const user = await signup('invalid-metric@example.com');
    const accountId = await accountFor(user.user.id);
    const tagged = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      headers: auth(user.accessToken),
      payload: jobBody(accountId, [metric({ name: 'successes', tags: { __name__: 'hidden' } })]),
    });
    expect(tagged.statusCode).toBe(400);
    const formula = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      headers: auth(user.accessToken),
      payload: jobBody(accountId, [
        metric({
          name: 'error_rate',
          type: 'gauge',
          category: 'dependent',
          dependsOn: ['errors'],
          formula: 'errors /',
        }),
        metric({ name: 'errors', category: 'error' }),
      ]),
    });
    expect(formula.statusCode).toBe(400);
    expect(await db.ingestionJob.count()).toBe(0);
  });

  it('pages jobs with limit and cursor', async () => {
    const user = await signup('pages@example.com');
    const accountId = await accountFor(user.user.id);
    for (const name of ['one', 'two', 'three']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: auth(user.accessToken),
        payload: {
          ...jobBody(accountId, [metric({ name: 'successes', category: 'success' })]),
          name,
        },
      });
      expect(response.statusCode).toBe(201);
    }
    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/jobs?limit=2',
      headers: auth(user.accessToken),
    });
    const page = first.json() as { items: Array<{ name: string }>; nextCursor: string | null };
    expect(page.items.map((item) => item.name)).toEqual(['three', 'two']);
    expect(page.nextCursor).toEqual(expect.any(String));
    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs?limit=2&cursor=${encodeURIComponent(page.nextCursor ?? '')}`,
      headers: auth(user.accessToken),
    });
    expect(second.json()).toMatchObject({ items: [{ name: 'one' }], nextCursor: null });
  });
});
