import {
  chunkPoints,
  createVendorAdapter,
  decryptJson,
  simulateTick,
  type MetricPoint,
  type PreparedMetric,
  type VendorCredentials,
  type VendorHttp,
} from '@fireweave/core';
import { Prisma, writeAudit, type Database } from '@fireweave/db';
import type { Redis } from 'ioredis';
import type { JobScheduler } from '@fireweave/queue';
import { limitVendorHttp, OutboundRateLimitError, type VendorName } from './bucket.js';
import { acquireLock, releaseLock, tickDeadlineAt } from './lock.js';
import { workerLog } from './log.js';
import {
  recordDeadlineExceeded,
  recordMetricsSent,
  recordTick,
  recordVendorError,
} from './metrics.js';

export class DeadlineError extends Error {
  constructor() {
    super('tick_deadline');
    this.name = 'DeadlineError';
  }
}

export type TickHooks = {
  afterBatchInsert?: (info: { jobId: string; batchId: string }) => Promise<void>;
};

export type TickContext = {
  db: Database;
  redis: Redis;
  encryptionKey: Buffer;
  http: VendorHttp;
  scheduler: JobScheduler;
  now?: () => Date;
  hooks?: TickHooks;
};

type AccountRow = {
  id: string;
  vendorType: VendorName;
  credentialsCipher: Uint8Array;
};

export async function runTick(jobId: string, ctx: TickContext): Promise<void> {
  const now = (ctx.now ?? (() => new Date()))();
  const job = await ctx.db.ingestionJob.findUnique({ where: { id: jobId } });
  if (!job || job.deletedAt || job.status !== 'active') {
    return;
  }
  if (job.endTime && job.endTime.getTime() <= now.getTime()) {
    await ctx.db.ingestionJob.update({ where: { id: job.id }, data: { status: 'completed' } });
    await ctx.scheduler.removeRepeatable(job.id, job.tickIntervalMs);
    workerLog({ jobId }, 'job completed because endTime passed');
    return;
  }

  const lock = await acquireLock(ctx.redis, job.id, job.tickIntervalMs);
  if (!lock) {
    return;
  }
  let locked = true;
  const started = Date.now();
  const release = async () => {
    if (!locked) {
      return;
    }
    locked = false;
    await releaseLock(ctx.redis, job.id, lock.owner);
  };

  try {
    const definitions = await loadDefinitions(ctx.db, job.id);
    const simulated = simulateTick({
      job: {
        id: job.id,
        timeZone: job.timezone,
        virtualUserCount: job.virtualUserCount,
        peakRatePerSecond: job.peakRatePerSecond,
        successProbability: job.successProbability,
        errorProbability: job.errorProbability,
        tickIntervalMs: job.tickIntervalMs,
        startTime: job.startTime,
        lastSimulatedAt: job.lastSimulatedAt,
      },
      definitions,
      now,
      consecutiveLagTicks: job.consecutiveLagTicks,
    });
    const duplicate = await ctx.db.ingestionBatch.findFirst({
      where: { jobId: job.id, windowStart: simulated.window.windowStart },
    });
    if (duplicate) {
      workerLog({ jobId, batchId: duplicate.id }, 'skipped a window that already has a batch');
      return;
    }

    const accounts = await loadAccounts(ctx.db, job.id);
    const batch = await ctx.db.ingestionBatch.create({
      data: {
        jobId: job.id,
        windowStart: simulated.window.windowStart,
        windowEnd: simulated.window.windowEnd,
        status: 'in_flight',
        deliveries: {
          create: accounts.map((account) => ({ vendorAccountId: account.id, status: 'pending' })),
        },
      },
      include: { deliveries: true },
    });
    workerLog({ jobId, batchId: batch.id }, 'batch inserted');
    if (ctx.hooks?.afterBatchInsert) {
      await ctx.hooks.afterBatchInsert({ jobId: job.id, batchId: batch.id });
    }

    const fresh = await ctx.db.ingestionJob.findUnique({ where: { id: job.id } });
    if (!fresh || fresh.deletedAt || fresh.status !== 'active') {
      await abandon(ctx.db, batch.id);
      recordTick(Date.now() - started, simulated.window.lagSeconds);
      workerLog({ jobId, batchId: batch.id }, 'batch abandoned before send');
      return;
    }

    const deadlineAt = tickDeadlineAt(job.tickIntervalMs);
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new DeadlineError()),
      Math.max(0, deadlineAt - Date.now()),
    );
    let deadlineHit = false;
    try {
      for (const account of accounts) {
        const delivery = batch.deliveries.find((row) => row.vendorAccountId === account.id);
        if (!delivery) {
          continue;
        }
        if (deadline.signal.aborted) {
          deadlineHit = true;
          break;
        }
        try {
          await sendAccount({
            ctx,
            jobId: job.id,
            batchId: batch.id,
            deliveryId: delivery.id,
            account,
            points: simulated.points,
            deadlineAt,
            deadline: deadline.signal,
          });
        } catch (error) {
          if (error instanceof DeadlineError || deadline.signal.aborted) {
            deadlineHit = true;
            break;
          }
          throw error;
        }
      }
      if (deadlineHit) {
        await deadLetterPending(ctx.db, job.id, batch.id, simulated.points);
        recordDeadlineExceeded();
        workerLog({ jobId, batchId: batch.id }, 'tick deadline exceeded');
      }
      await finishTick(
        ctx,
        job.id,
        batch.id,
        simulated.window.windowEnd,
        simulated.window.consecutiveLagTicks,
        simulated.window.autoFail,
      );
      recordTick(Date.now() - started, simulated.window.lagSeconds);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await release();
  }
}

export async function deliverInject(
  input: { jobId: string; metricDefinitionId: string; value: number; timestamp: string },
  ctx: Pick<TickContext, 'db' | 'encryptionKey' | 'http' | 'redis'>,
): Promise<void> {
  const job = await ctx.db.ingestionJob.findUnique({ where: { id: input.jobId } });
  if (!job || job.deletedAt) {
    return;
  }
  const definition = await ctx.db.metricDefinition.findFirst({
    where: { id: input.metricDefinitionId, jobId: job.id },
  });
  if (!definition) {
    return;
  }
  const point: MetricPoint = {
    name: definition.name,
    type: definition.type,
    value: input.value,
    timestamp: new Date(input.timestamp),
    tags: tagsFromJson(definition.tags),
  };
  const accounts = await loadAccounts(ctx.db, job.id);
  for (const account of accounts) {
    let credentials: VendorCredentials | undefined;
    try {
      credentials = readCredentials(account.credentialsCipher, ctx.encryptionKey);
      const deadline = new AbortController();
      const adapter = createVendorAdapter({
        accountId: account.id,
        credentials,
        http: limitVendorHttp({
          http: ctx.http,
          redis: ctx.redis,
          accountId: account.id,
          vendorType: account.vendorType,
          deadlineAt: Date.now() + 5_000,
          deadline: deadline.signal,
        }),
      });
      workerLog({ jobId: job.id, vendorAccountId: account.id }, 'inject');
      const result = await adapter.ingestMetrics([point], {
        batchId: `inject:${input.metricDefinitionId}`,
      });
      if (result.ok) {
        recordMetricsSent(1);
      } else {
        recordVendorError();
        workerLog({ jobId: job.id, vendorAccountId: account.id }, result.error ?? 'vendor_error');
      }
    } catch (error) {
      if (!(error instanceof OutboundRateLimitError)) {
        throw error;
      }
      recordVendorError();
      workerLog({ jobId: job.id, vendorAccountId: account.id }, 'rate_limited');
    } finally {
      credentials = undefined;
    }
  }
}

async function finishTick(
  ctx: TickContext,
  jobId: string,
  batchId: string,
  windowEnd: Date,
  consecutiveLagTicks: number,
  autoFail: boolean,
): Promise<void> {
  const job = await ctx.db.ingestionJob.findUnique({ where: { id: jobId } });
  await ctx.db.ingestionBatch.update({
    where: { id: batchId },
    data: { status: 'completed', completedAt: new Date() },
  });
  await ctx.db.ingestionJob.update({
    where: { id: jobId },
    data: {
      lastSimulatedAt: windowEnd,
      consecutiveLagTicks,
      ...(autoFail ? { status: 'failed' } : {}),
    },
  });
  if (autoFail && job) {
    await writeAudit(ctx.db, {
      userId: job.userId,
      action: 'job.auto_failed',
      entityType: 'job',
      entityId: jobId,
      metadata: { consecutiveLagTicks },
    });
    await ctx.scheduler.removeRepeatable(jobId, job.tickIntervalMs);
    workerLog({ jobId, batchId }, 'job failed after repeated lag');
  }
  workerLog({ jobId, batchId }, 'batch completed');
}

async function sendAccount(input: {
  ctx: TickContext;
  jobId: string;
  batchId: string;
  deliveryId: string;
  account: AccountRow;
  points: MetricPoint[];
  deadlineAt: number;
  deadline: AbortSignal;
}): Promise<void> {
  let credentials: VendorCredentials | undefined;
  let attempts = 0;
  try {
    credentials = readCredentials(input.account.credentialsCipher, input.ctx.encryptionKey);
    const http = withDeadline(
      limitVendorHttp({
        http: input.ctx.http,
        redis: input.ctx.redis,
        accountId: input.account.id,
        vendorType: input.account.vendorType,
        deadlineAt: input.deadlineAt,
        deadline: input.deadline,
      }),
      input.deadline,
      input.deadlineAt,
    );
    const adapter = createVendorAdapter({
      accountId: input.account.id,
      credentials,
      http,
    });
    const chunks = chunkPoints(input.points);
    const work = chunks.length === 0 ? [[]] : chunks;
    for (const chunk of work) {
      const result = await sendChunk(
        adapter,
        chunk,
        input.batchId,
        input.deadlineAt,
        input.deadline,
        (count) => {
          attempts = count;
        },
      );
      if (!result.ok) {
        await markDead(
          input.ctx.db,
          input.jobId,
          input.deliveryId,
          input.account.id,
          attempts,
          input.points,
          result.error ?? `http_${result.statusCode}`,
        );
        return;
      }
    }
    await input.ctx.db.ingestionDelivery.update({
      where: { id: input.deliveryId },
      data: { status: 'delivered', attemptCount: Math.max(attempts, 1), error: null },
    });
    workerLog(
      { jobId: input.jobId, batchId: input.batchId, vendorAccountId: input.account.id },
      'delivered',
    );
  } catch (error) {
    if (error instanceof DeadlineError || input.deadline.aborted) {
      throw new DeadlineError();
    }
    await markDead(
      input.ctx.db,
      input.jobId,
      input.deliveryId,
      input.account.id,
      attempts,
      input.points,
      error instanceof Error ? error.message : 'vendor_error',
    );
  } finally {
    credentials = undefined;
  }
}

async function sendChunk(
  adapter: {
    ingestMetrics(
      metrics: MetricPoint[],
      options: { batchId: string },
    ): Promise<{ ok: boolean; statusCode: number; acceptedCount: number; error?: string }>;
  },
  chunk: MetricPoint[],
  batchId: string,
  deadlineAt: number,
  deadline: AbortSignal,
  onAttempt: (count: number) => void,
): Promise<{ ok: boolean; statusCode: number; error?: string }> {
  let last = { ok: false, statusCode: 0, error: 'vendor_error' };
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    if (deadline.aborted || Date.now() >= deadlineAt) {
      throw new DeadlineError();
    }
    onAttempt(attempt);
    try {
      const result = await adapter.ingestMetrics(chunk, { batchId });
      if (result.ok) {
        recordMetricsSent(chunk.length);
        return result;
      }
      last = {
        ok: false,
        statusCode: result.statusCode,
        error: result.error ?? `http_${result.statusCode}`,
      };
      if (result.statusCode !== 429 && result.statusCode < 500) {
        return last;
      }
    } catch (error) {
      if (error instanceof OutboundRateLimitError) {
        return { ok: false, statusCode: 0, error: 'rate_limited' };
      }
      if (error instanceof DeadlineError || deadline.aborted) {
        throw new DeadlineError();
      }
      last = {
        ok: false,
        statusCode: 0,
        error: error instanceof Error ? error.message : 'vendor_error',
      };
    }
    if (attempt === 5) {
      return last;
    }
    const wait = backoffMs(attempt);
    if (Date.now() + wait >= deadlineAt) {
      return last;
    }
    await sleep(wait, deadline);
  }
  return last;
}

async function deadLetterPending(
  db: Database,
  jobId: string,
  batchId: string,
  points: MetricPoint[],
): Promise<void> {
  const pending = await db.ingestionDelivery.findMany({
    where: { batchId, status: 'pending' },
  });
  if (pending.length === 0) {
    return;
  }
  await db.ingestionDelivery.updateMany({
    where: { id: { in: pending.map((delivery) => delivery.id) } },
    data: { status: 'dead', error: 'tick_deadline' },
  });
  recordVendorError(pending.length);
  await db.ingestionFailure.createMany({
    data: pending.map((delivery) => ({
      jobId,
      vendorAccountId: delivery.vendorAccountId,
      deliveryId: delivery.id,
      reason: 'tick_deadline',
      payload: pointPayload(points),
    })),
  });
}

async function markDead(
  db: Database,
  jobId: string,
  deliveryId: string,
  vendorAccountId: string,
  attempts: number,
  points: MetricPoint[],
  reason: string,
): Promise<void> {
  await db.ingestionDelivery.update({
    where: { id: deliveryId },
    data: { status: 'dead', attemptCount: attempts, error: reason },
  });
  await db.ingestionFailure.create({
    data: {
      jobId,
      vendorAccountId,
      deliveryId,
      reason,
      payload: pointPayload(points),
    },
  });
  recordVendorError();
  workerLog({ jobId, vendorAccountId }, reason);
}

async function abandon(db: Database, batchId: string): Promise<void> {
  await db.ingestionBatch.update({
    where: { id: batchId },
    data: { status: 'abandoned', completedAt: new Date() },
  });
  await db.ingestionDelivery.updateMany({
    where: { batchId, status: 'pending' },
    data: { status: 'dead', error: 'discarded' },
  });
}

function withDeadline(http: VendorHttp, deadline: AbortSignal, deadlineAt: number): VendorHttp {
  return {
    async request(input) {
      const remaining = Math.max(1, Math.min(10_000, deadlineAt - Date.now()));
      const signal = AbortSignal.any([
        deadline,
        AbortSignal.timeout(remaining),
        ...(input.signal ? [input.signal] : []),
      ]);
      try {
        return await http.request({ ...input, signal });
      } catch (error) {
        if (deadline.aborted || Date.now() >= deadlineAt - 25) {
          throw new DeadlineError();
        }
        throw error;
      }
    },
  };
}

function backoffMs(attempt: number): number {
  const base = Math.min(1000, 100 * 2 ** (attempt - 1));
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DeadlineError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DeadlineError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function loadDefinitions(db: Database, jobId: string): Promise<PreparedMetric[]> {
  const rows = await db.metricDefinition.findMany({
    where: { jobId },
    orderBy: { evalOrder: 'asc' },
  });
  return rows.map((row) => ({
    name: row.name,
    type: row.type,
    category: row.category,
    tags: tagsFromJson(row.tags),
    dependsOn: row.dependsOn,
    formula: row.formula,
    evalOrder: row.evalOrder,
    successProbability: row.successProbability,
    errorProbability: row.errorProbability,
  }));
}

async function loadAccounts(db: Database, jobId: string): Promise<AccountRow[]> {
  const links = await db.jobVendorAccount.findMany({
    where: { jobId },
    include: { vendorAccount: true },
    orderBy: { vendorAccountId: 'asc' },
  });
  return links
    .map((link) => link.vendorAccount)
    .filter((account) => account.deletedAt === null)
    .map((account) => ({
      id: account.id,
      vendorType: account.vendorType,
      credentialsCipher: account.credentialsCipher,
    }));
}

function readCredentials(payload: Uint8Array, key: Buffer): VendorCredentials {
  const parsed = decryptJson(Buffer.from(payload), key);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Stored credentials are unreadable');
  }
  const record = parsed as { vendorType?: unknown; credentials?: unknown };
  if (
    (record.vendorType !== 'openobserve' &&
      record.vendorType !== 'datadog' &&
      record.vendorType !== 'sentry') ||
    !record.credentials ||
    typeof record.credentials !== 'object'
  ) {
    throw new Error('Stored credentials are unreadable');
  }
  return record as VendorCredentials;
}

function pointPayload(points: MetricPoint[]): Prisma.InputJsonValue {
  return points.map((point) => ({
    name: point.name,
    type: point.type,
    value: point.value,
    timestamp: point.timestamp.toISOString(),
    tags: point.tags,
  }));
}

function tagsFromJson(value: Prisma.JsonValue): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const tags: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      tags[key] = entry;
    }
  }
  return tags;
}
