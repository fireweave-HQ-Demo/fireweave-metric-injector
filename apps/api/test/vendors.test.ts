import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { VendorHttp, VendorRequest } from '@fireweave/core';
import { createPrismaClient } from '@fireweave/db';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const databaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgresql://fireweave:fireweave@localhost:5432/fireweave_test';
const encryptionKey = Buffer.alloc(32, 7);

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: encryptionKey.toString('base64'),
  JWT_ACCESS_SECRET: 'test-access-secret-must-be-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-must-be-32-characters',
  AUTH_RATE_LIMIT_MAX: '1000',
});

const db = createPrismaClient(databaseUrl);
const calls: VendorRequest[] = [];
let mode: 'accept' | 'reject' = 'accept';
const http: VendorHttp = {
  async request(input) {
    calls.push(input);
    if (mode === 'reject') {
      return { status: 401, body: '{"valid":false}' };
    }
    return { status: 200, body: '{"valid":true}' };
  },
};

let app: FastifyInstance;
let ipCounter = 0;

const secrets = {
  ooPassword: 'oo-password-SECRET',
  ooEmail: 'metrics-user@example.com',
  ooToken: 'oo-token-SECRET9999',
  ddApiKey: 'dd-api-key-0123456789abcd',
  ddAppKey: 'dd-app-key-ffffffffffffffff',
  sentryKey: 'sntry-public-key-ABCDEF',
  sentryToken: 'sntrys-org-token-SECRET999',
};

function nextIp(): string {
  ipCounter += 1;
  return `10.8.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
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

describe('vendor accounts', () => {
  beforeAll(async () => {
    execSync('pnpm --filter @fireweave/db migrate:deploy', {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    });
    app = await buildApp(config, { vendorHttp: http });
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  beforeEach(async () => {
    mode = 'accept';
    calls.length = 0;
    await db.$executeRaw`UPDATE refresh_tokens SET parent_id = NULL, replaced_by_id = NULL`;
    await db.refreshToken.deleteMany();
    await db.user.deleteMany();
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/vendor-accounts' });
    expect(response.statusCode).toBe(401);
  });

  it('returns hints and never the stored secrets', async () => {
    const user = await signup('vendors@example.com');
    const created = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/vendor-accounts',
        headers: auth(user.accessToken),
        payload: {
          vendorType: 'openobserve',
          label: 'oo-password',
          credentials: {
            baseUrl: 'https://oo.example',
            organization: 'default',
            email: secrets.ooEmail,
            password: secrets.ooPassword,
          },
        },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/vendor-accounts',
        headers: auth(user.accessToken),
        payload: {
          vendorType: 'openobserve',
          label: 'oo-token',
          credentials: {
            baseUrl: 'https://oo.example',
            organization: 'default',
            token: secrets.ooToken,
          },
        },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/vendor-accounts',
        headers: auth(user.accessToken),
        payload: {
          vendorType: 'datadog',
          label: 'datadog',
          credentials: { apiKey: secrets.ddApiKey, appKey: secrets.ddAppKey, site: 'datadog.test' },
        },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/vendor-accounts',
        headers: auth(user.accessToken),
        payload: {
          vendorType: 'sentry',
          label: 'sentry',
          credentials: {
            dsn: `https://${secrets.sentryKey}@o123.ingest.sentry.io/42`,
            organization: 'acme',
            project: 'web',
            orgAuthToken: secrets.sentryToken,
          },
        },
      }),
    ]);
    for (const response of created) {
      expect(response.statusCode).toBe(201);
    }
    const bodies = created.map(
      (response) => response.json() as { credentialHint: string; credentialKind: string },
    );
    expect(bodies.map((body) => body.credentialKind).sort()).toEqual([
      'api_key',
      'dsn_key',
      'email',
      'token',
    ]);
    expect(bodies.find((body) => body.credentialKind === 'email')?.credentialHint).toBe('.com');
    expect(bodies.find((body) => body.credentialKind === 'token')?.credentialHint).toBe('9999');
    expect(bodies.find((body) => body.credentialKind === 'api_key')?.credentialHint).toBe('abcd');
    expect(bodies.find((body) => body.credentialKind === 'dsn_key')?.credentialHint).toBe('CDEF');

    const serialized = JSON.stringify(bodies);
    for (const secret of Object.values(secrets)) {
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(secret.slice(0, -4));
    }
    expect(serialized).not.toContain('credentialsCipher');
    expect(serialized).not.toContain(`https://${secrets.sentryKey}@`);
  });

  it('stores nothing when the vendor rejects the credentials', async () => {
    const user = await signup('reject@example.com');
    mode = 'reject';
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/vendor-accounts',
      headers: auth(user.accessToken),
      payload: {
        vendorType: 'datadog',
        label: 'rejected',
        credentials: { apiKey: secrets.ddApiKey, appKey: secrets.ddAppKey, site: 'datadoghq.com' },
      },
    });
    expect(response.statusCode).toBe(422);
    expect(await db.vendorAccount.count()).toBe(0);
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/vendor-accounts',
      headers: auth(user.accessToken),
    });
    expect(list.json()).toEqual({ items: [], nextCursor: null });
  });

  it('keeps the previous cipher when a replacement is rejected', async () => {
    const user = await signup('replace@example.com');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/vendor-accounts',
      headers: auth(user.accessToken),
      payload: {
        vendorType: 'openobserve',
        label: 'primary',
        credentials: {
          baseUrl: 'https://oo.example',
          organization: 'default',
          email: secrets.ooEmail,
          password: secrets.ooPassword,
        },
      },
    });
    const account = created.json() as { id: string };
    const before = await db.vendorAccount.findUniqueOrThrow({ where: { id: account.id } });
    mode = 'reject';
    calls.length = 0;
    const replaced = await app.inject({
      method: 'PATCH',
      url: `/api/v1/vendor-accounts/${account.id}`,
      headers: auth(user.accessToken),
      payload: {
        credentials: {
          baseUrl: 'https://oo.example',
          organization: 'default',
          email: secrets.ooEmail,
          password: 'new-password-SECRET',
        },
      },
    });
    expect(replaced.statusCode).toBe(422);
    const after = await db.vendorAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(Buffer.from(after.credentialsCipher).equals(Buffer.from(before.credentialsCipher))).toBe(
      true,
    );

    mode = 'accept';
    calls.length = 0;
    const checked = await app.inject({
      method: 'POST',
      url: `/api/v1/vendor-accounts/${account.id}/validate`,
      headers: auth(user.accessToken),
    });
    expect(checked.statusCode).toBe(200);
    expect(calls[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from(`${secrets.ooEmail}:${secrets.ooPassword}`).toString('base64')}`,
    );
    expect(JSON.stringify(calls)).not.toContain('new-password-SECRET');
  });

  it('blocks deletion while a job is scheduled, active, or paused', async () => {
    const user = await signup('jobs@example.com');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/vendor-accounts',
      headers: auth(user.accessToken),
      payload: {
        vendorType: 'datadog',
        label: 'shared',
        credentials: { apiKey: secrets.ddApiKey, appKey: secrets.ddAppKey, site: 'datadoghq.com' },
      },
    });
    const account = created.json() as { id: string };
    const job = await db.ingestionJob.create({
      data: {
        userId: user.user.id,
        name: 'nightly',
        status: 'paused',
        timezone: 'UTC',
        virtualUserCount: 1,
        peakRatePerSecond: 1,
        successProbability: 0.9,
        errorProbability: 0.1,
        startTime: new Date('2026-01-02T00:00:00.000Z'),
        accounts: { create: { vendorAccountId: account.id } },
      },
    });

    for (const status of ['paused', 'scheduled', 'active'] as const) {
      await db.ingestionJob.update({ where: { id: job.id }, data: { status } });
      const blocked = await app.inject({
        method: 'DELETE',
        url: `/api/v1/vendor-accounts/${account.id}`,
        headers: auth(user.accessToken),
      });
      expect(blocked.statusCode).toBe(409);
    }

    await db.ingestionJob.update({ where: { id: job.id }, data: { status: 'completed' } });
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/vendor-accounts/${account.id}`,
      headers: auth(user.accessToken),
    });
    expect(removed.statusCode).toBe(204);
    const row = await db.vendorAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(Buffer.from(row.credentialsCipher).length).toBe(0);
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/vendor-accounts',
      headers: auth(user.accessToken),
    });
    expect(list.json()).toEqual({ items: [], nextCursor: null });
  });

  it('pages accounts and hides another user', async () => {
    const owner = await signup('owner@example.com');
    const other = await signup('other@example.com');
    for (const label of ['one', 'two', 'three']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/vendor-accounts',
        headers: auth(owner.accessToken),
        payload: {
          vendorType: 'openobserve',
          label,
          credentials: {
            baseUrl: 'https://oo.example',
            organization: 'default',
            token: `${label}-token-SECRET9999`,
          },
        },
      });
      expect(response.statusCode).toBe(201);
    }
    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/vendor-accounts?limit=2',
      headers: auth(owner.accessToken),
    });
    const page = first.json() as {
      items: Array<{ id: string; label: string }>;
      nextCursor: string | null;
    };
    expect(page.items.map((item) => item.label)).toEqual(['three', 'two']);
    expect(page.nextCursor).toEqual(expect.any(String));
    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/vendor-accounts?limit=2&cursor=${encodeURIComponent(page.nextCursor ?? '')}`,
      headers: auth(owner.accessToken),
    });
    expect(second.json()).toMatchObject({ items: [{ label: 'one' }], nextCursor: null });

    const hidden = await app.inject({
      method: 'DELETE',
      url: `/api/v1/vendor-accounts/${page.items[0]?.id}`,
      headers: auth(other.accessToken),
    });
    expect(hidden.statusCode).toBe(404);
  });

  it('rejects an unsafe base URL before calling the vendor', async () => {
    const user = await signup('unsafe@example.com');
    calls.length = 0;
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/vendor-accounts',
      headers: auth(user.accessToken),
      payload: {
        vendorType: 'openobserve',
        label: 'local',
        credentials: {
          baseUrl: 'http://127.0.0.1:5080',
          organization: 'default',
          token: secrets.ooToken,
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
    expect(await db.vendorAccount.count()).toBe(0);
  });
});
