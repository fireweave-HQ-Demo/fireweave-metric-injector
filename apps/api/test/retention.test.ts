import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient } from '@fireweave/db';
import { FAILURE_RETENTION_MS, sweepRetention } from '@fireweave/worker';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const databaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgresql://fireweave:fireweave@localhost:5432/fireweave_test';
const db = createPrismaClient(databaseUrl);

describe('failure retention', () => {
  beforeAll(() => {
    execSync('pnpm --filter @fireweave/db migrate:deploy', {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    });
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { email: 'retention@example.com' } });
    await db.$disconnect();
  });

  it('deletes failures and dead deliveries older than 7 days', async () => {
    const now = new Date('2026-11-07T00:00:00.000Z');
    const old = new Date(now.getTime() - FAILURE_RETENTION_MS - 60_000);
    const recent = new Date(now.getTime() - 60_000);
    const user = await db.user.create({
      data: { email: 'retention@example.com', passwordHash: 'unused' },
    });
    const account = await db.vendorAccount.create({
      data: {
        userId: user.id,
        vendorType: 'datadog',
        label: 'retention',
        credentialsCipher: new Uint8Array(),
        credentialHint: '1234',
        credentialKind: 'api_key',
        validatedAt: now,
      },
    });
    const job = await db.ingestionJob.create({
      data: {
        userId: user.id,
        name: 'retention',
        status: 'paused',
        timezone: 'UTC',
        virtualUserCount: 1,
        peakRatePerSecond: 1,
        successProbability: 1,
        errorProbability: 0,
        startTime: now,
      },
    });
    const batch = await db.ingestionBatch.create({
      data: {
        jobId: job.id,
        windowStart: now,
        windowEnd: now,
        status: 'completed',
      },
    });
    const dead = await db.ingestionDelivery.create({
      data: { batchId: batch.id, vendorAccountId: account.id, status: 'dead', createdAt: old },
    });
    const delivered = await db.ingestionDelivery.create({
      data: {
        batchId: batch.id,
        vendorAccountId: account.id,
        status: 'delivered',
        createdAt: old,
      },
    });
    const expired = await db.ingestionFailure.create({
      data: { jobId: job.id, deliveryId: dead.id, reason: 'old', payload: {}, createdAt: old },
    });
    const kept = await db.ingestionFailure.create({
      data: { jobId: job.id, reason: 'recent', payload: {}, createdAt: recent },
    });

    const swept = await sweepRetention(db, now);
    expect(swept.failures).toBeGreaterThanOrEqual(1);
    expect(swept.deliveries).toBeGreaterThanOrEqual(1);
    expect(await db.ingestionFailure.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(await db.ingestionFailure.findUnique({ where: { id: kept.id } })).not.toBeNull();
    expect(await db.ingestionDelivery.findUnique({ where: { id: dead.id } })).toBeNull();
    expect(await db.ingestionDelivery.findUnique({ where: { id: delivered.id } })).not.toBeNull();

    await db.user.delete({ where: { id: user.id } });
  });
});
