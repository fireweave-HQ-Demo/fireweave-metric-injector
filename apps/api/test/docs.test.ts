import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
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
});

describe('openapi', () => {
  let app: FastifyInstance;

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
  });

  it('publishes the route schemas at /docs', async () => {
    const page = await app.inject({ method: 'GET', url: '/docs' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');

    const spec = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(spec.statusCode).toBe(200);
    const body = spec.json() as { paths?: Record<string, { post?: { requestBody?: unknown } }> };
    expect(body.paths?.['/auth/signup']?.post?.requestBody).toBeTruthy();
    expect(body.paths?.['/api/v1/jobs']?.post?.requestBody).toBeTruthy();
    expect(body.paths?.['/api/v1/vendor-accounts']?.post?.requestBody).toBeTruthy();
    expect(body.paths?.['/api/v1/jobs/{id}/inject']?.post?.requestBody).toBeTruthy();
    expect(body.paths?.['/health']).toBeTruthy();
  });
});
