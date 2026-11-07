import { Worker } from 'bullmq';
import type { Server } from 'node:http';
import type { Database } from '@fireweave/db';
import {
  createJobScheduler,
  createRedis,
  INGESTION_QUEUE,
  type IngestionJobData,
  type JobScheduler,
} from '@fireweave/queue';
import type { VendorHttp } from '@fireweave/core';
import { repairOnStartup } from './repair.js';
import { RETENTION_SWEEP_INTERVAL_MS, sweepRetention } from './retention.js';
import { deliverInject, runTick, type TickContext, type TickHooks } from './tick.js';
import { workerLog } from './log.js';
import { startWorkerMetrics } from './metrics.js';

export type WorkerHandle = {
  shutdown(): Promise<void>;
};

export async function startIngestionWorker(options: {
  redisUrl: string;
  prefix?: string;
  db: Database;
  encryptionKey: Buffer;
  http: VendorHttp;
  scheduler?: JobScheduler;
  now?: () => Date;
  hooks?: TickHooks;
  concurrency?: number;
  metricsPort?: number;
}): Promise<WorkerHandle> {
  const scheduler =
    options.scheduler ?? createJobScheduler(options.redisUrl, { prefix: options.prefix });
  const ownsScheduler = options.scheduler === undefined;
  const connection = createRedis(options.redisUrl);
  const metrics =
    options.metricsPort === undefined
      ? null
      : await startWorkerMetrics(options.db, options.metricsPort);
  await repairOnStartup(options.db);
  await sweepRetention(options.db);
  const retentionTimer = setInterval(() => {
    sweepRetention(options.db).catch((error: unknown) => {
      workerLog({}, error instanceof Error ? error.message : 'retention sweep failed');
    });
  }, RETENTION_SWEEP_INTERVAL_MS);
  retentionTimer.unref();
  const context: TickContext = {
    db: options.db,
    redis: connection,
    encryptionKey: options.encryptionKey,
    http: options.http,
    scheduler,
    ...(options.now ? { now: options.now } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
  };
  let current: Promise<void> | null = null;
  const worker = new Worker<IngestionJobData>(
    INGESTION_QUEUE,
    async (job) => {
      const run = processJob(job.data, context);
      current = run;
      try {
        await run;
      } finally {
        if (current === run) {
          current = null;
        }
      }
    },
    { connection, prefix: scheduler.prefix, concurrency: options.concurrency ?? 4 },
  );
  worker.on('error', (error) => {
    workerLog({}, error.message);
  });

  let closed = false;
  return {
    async shutdown() {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(retentionTimer);
      await worker.pause(true);
      if (current) {
        await current;
      }
      await worker.close();
      await closeServer(metrics);
      await connection.quit();
      if (ownsScheduler) {
        await scheduler.close();
      }
    },
  };
}

async function processJob(data: IngestionJobData, ctx: TickContext): Promise<void> {
  if (data.type === 'start') {
    await promote(ctx, data.jobId);
    return;
  }
  if (data.type === 'inject') {
    await deliverInject(data, ctx);
    return;
  }
  try {
    await runTick(data.jobId, ctx);
  } catch (error) {
    workerLog({ jobId: data.jobId }, error instanceof Error ? error.message : 'tick failed');
  }
}

async function promote(ctx: TickContext, jobId: string): Promise<void> {
  const updated = await ctx.db.ingestionJob.updateMany({
    where: { id: jobId, status: 'scheduled', deletedAt: null },
    data: { status: 'active' },
  });
  if (updated.count === 0) {
    return;
  }
  const job = await ctx.db.ingestionJob.findUnique({ where: { id: jobId } });
  if (!job) {
    return;
  }
  await ctx.scheduler.addRepeatable(job.id, job.tickIntervalMs);
  workerLog({ jobId }, 'scheduled job is active');
}

function closeServer(server: Server | null): Promise<void> {
  if (!server) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export { deliverInject, runTick } from './tick.js';
export {
  OutboundRateLimitError,
  defaultOutboundLimit,
  outboundLimitKey,
  takeToken,
} from './bucket.js';
export { registry, renderMetrics, startWorkerMetrics } from './metrics.js';
export { logEvent, resetWorkerLog, useWorkerLogStream } from './log.js';
export { loadWorkerConfig } from './config.js';
export type { TickContext, TickHooks } from './tick.js';
export { repairOnStartup } from './repair.js';
export { FAILURE_RETENTION_MS, sweepRetention } from './retention.js';
export { resetWorkerCounters, workerCounters } from './counters.js';
