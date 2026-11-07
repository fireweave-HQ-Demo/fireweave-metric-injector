import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPrismaClient } from '@fireweave/db';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ACCESS_AUDIENCE, ACCESS_ISSUER } from '../src/auth/tokens.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const databaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgresql://fireweave:fireweave@localhost:5432/fireweave_test';
const accessSecret = 'test-access-secret-must-be-32-characters';
const acceptedPassword = 'rK7#mQ2vLp9x';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  JWT_ACCESS_SECRET: accessSecret,
  JWT_REFRESH_SECRET: 'test-refresh-secret-must-be-32-characters',
  AUTH_RATE_LIMIT_MAX: '5',
});

const db = createPrismaClient(databaseUrl);
let app: FastifyInstance;
let ipCounter = 0;

function nextIp(): string {
  ipCounter += 1;
  const a = (ipCounter >> 16) & 255;
  const b = (ipCounter >> 8) & 255;
  const c = ipCounter & 255;
  return `10.${a}.${b}.${c}`;
}

function refreshCookie(setCookie: string | string[] | undefined): string {
  const lines = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const line = lines.find((entry) => entry.startsWith('refresh_token='));
  if (!line) {
    throw new Error('missing refresh cookie');
  }
  const pair = line.split(';', 1)[0];
  if (!pair) {
    throw new Error('missing refresh cookie');
  }
  return pair;
}

async function signup(email: string, password: string, remoteAddress = nextIp()) {
  return app.inject({
    method: 'POST',
    url: '/auth/signup',
    remoteAddress,
    payload: { email, password },
  });
}

describe('auth', () => {
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

  it('pins the SecLists denylist at 100000 passwords', () => {
    const path = fileURLToPath(new URL('../../../data/password-denylist.txt', import.meta.url));
    const entries = readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(entries).toHaveLength(100_000);
    expect(entries[0]).toBe('123456');
    expect(entries[1]).toBe('password');
  });

  it('rejects short and common passwords and accepts a password off the list', async () => {
    const short = await signup('short@example.com', 'password');
    expect(short.statusCode).toBe(400);
    expect(short.json().error.message).toMatch(/12 and 128/);

    const digits = await signup('digits@example.com', '123456');
    expect(digits.statusCode).toBe(400);
    expect(digits.json().error.message).toMatch(/12 and 128/);

    const common = await signup('common@example.com', '123qweasdzxc');
    expect(common.statusCode).toBe(400);
    expect(common.json().error.message).toMatch(/too common/i);

    const created = await signup('ok@example.com', acceptedPassword);
    expect(created.statusCode).toBe(201);
    expect(created.json().user.email).toBe('ok@example.com');
    expect(created.json().accessToken).toEqual(expect.any(String));
    const cookie = created.headers['set-cookie'];
    const serialized = Array.isArray(cookie) ? cookie.join(';') : String(cookie);
    expect(serialized).toMatch(/HttpOnly/i);
    expect(serialized).toMatch(/SameSite=Lax/i);
    expect(serialized).toMatch(/Path=\/auth/i);
    expect(serialized).not.toMatch(/Secure/i);
  });

  it('returns 401 for /api/v1/jobs without a token and 200 with a token', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/v1/jobs',
      remoteAddress: nextIp(),
    });
    expect(anonymous.statusCode).toBe(401);

    const created = await signup('jobs@example.com', acceptedPassword);
    const authed = await app.inject({
      method: 'GET',
      url: '/api/v1/jobs',
      remoteAddress: nextIp(),
      headers: { authorization: `Bearer ${created.json().accessToken}` },
    });
    expect(authed.statusCode).toBe(200);
    expect(authed.json()).toEqual({ items: [], nextCursor: null });
  });

  it('revokes the refresh chain when a rotated token is presented again', async () => {
    const created = await signup('rotate@example.com', acceptedPassword);
    const original = refreshCookie(created.headers['set-cookie']);

    const rotated = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      remoteAddress: nextIp(),
      headers: { cookie: original },
    });
    expect(rotated.statusCode).toBe(200);
    const replacement = refreshCookie(rotated.headers['set-cookie']);

    const reuse = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      remoteAddress: nextIp(),
      headers: { cookie: original },
    });
    expect(reuse.statusCode).toBe(401);

    const successor = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      remoteAddress: nextIp(),
      headers: { cookie: replacement },
    });
    expect(successor.statusCode).toBe(401);
  });

  it('rejects refresh when the access token subject does not match, and does not rotate', async () => {
    const first = await signup('a@example.com', acceptedPassword);
    const second = await signup('b@example.com', acceptedPassword);
    const firstCookie = refreshCookie(first.headers['set-cookie']);

    const mismatch = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      remoteAddress: nextIp(),
      headers: {
        cookie: firstCookie,
        authorization: `Bearer ${second.json().accessToken}`,
      },
    });
    expect(mismatch.statusCode).toBe(401);
    expect(mismatch.json().error.message).toMatch(/subject mismatch/i);

    const stillValid = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      remoteAddress: nextIp(),
      headers: { cookie: firstCookie },
    });
    expect(stillValid.statusCode).toBe(200);
  });

  it('accepts an expired access token on refresh when the subject matches', async () => {
    const created = await signup('expired@example.com', acceptedPassword);
    const userId = created.json().user.id as string;
    const expired = await new SignJWT({ email: 'expired@example.com', role: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(ACCESS_ISSUER)
      .setAudience(ACCESS_AUDIENCE)
      .setIssuedAt(1)
      .setExpirationTime(2)
      .sign(new TextEncoder().encode(accessSecret));

    const refreshed = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      remoteAddress: nextIp(),
      headers: {
        cookie: refreshCookie(created.headers['set-cookie']),
        authorization: `Bearer ${expired}`,
      },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().user.id).toBe(userId);
  });

  it('logs in with the right password, rejects the wrong one, and logout kills the chain', async () => {
    await signup('login@example.com', acceptedPassword);
    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: nextIp(),
      payload: { email: 'login@example.com', password: 'not-the-password' },
    });
    expect(wrong.statusCode).toBe(401);

    const loggedIn = await app.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: nextIp(),
      payload: { email: 'Login@Example.com', password: acceptedPassword },
    });
    expect(loggedIn.statusCode).toBe(200);
    const cookie = refreshCookie(loggedIn.headers['set-cookie']);

    const loggedOut = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      remoteAddress: nextIp(),
      headers: { cookie },
    });
    expect(loggedOut.statusCode).toBe(204);

    const refresh = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      remoteAddress: nextIp(),
      headers: { cookie },
    });
    expect(refresh.statusCode).toBe(401);
  });

  it('rate limits auth requests per IP and leaves health unlimited', async () => {
    const remoteAddress = '10.9.9.9';
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        remoteAddress,
        payload: { email: `rate-${attempt}@example.com`, password: 'password' },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
    expect(statuses[5]).toBe(429);

    const health = await app.inject({ method: 'GET', url: '/health', remoteAddress });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });
  });
});
