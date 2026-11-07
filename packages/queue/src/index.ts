import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const INGESTION_QUEUE = 'ingestion';

export type TickJobData = { type: 'tick'; jobId: string };
export type StartJobData = { type: 'start'; jobId: string };
export type InjectJobData = {
  type: 'inject';
  jobId: string;
  metricDefinitionId: string;
  value: number;
  timestamp: string;
};
export type IngestionJobData = TickJobData | StartJobData | InjectJobData;

const JOB_OPTIONS = {
  removeOnComplete: 100,
  removeOnFail: 500,
  attempts: 1,
} as const;

export type JobScheduler = {
  addRepeatable(jobId: string, everyMs: number): Promise<void>;
  removeRepeatable(jobId: string, everyMs: number): Promise<void>;
  addStarter(jobId: string, startTime: Date): Promise<void>;
  removeStarter(jobId: string): Promise<void>;
  enqueueInject(job: Omit<InjectJobData, 'type'>): Promise<void>;
  claimInjectSlot(jobId: string, limit?: number): Promise<boolean>;
  listRepeatables(): Promise<Array<{ id?: string; key: string; name: string }>>;
  reset(): Promise<void>;
  redis: Redis;
  prefix: string;
  close(): Promise<void>;
};

export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export function createJobScheduler(
  redisUrl: string,
  options: { prefix?: string } = {},
): JobScheduler {
  const prefix = options.prefix ?? 'fireweave';
  const connection = createRedis(redisUrl);
  const queue = new Queue<IngestionJobData>(INGESTION_QUEUE, {
    connection,
    prefix,
    defaultJobOptions: JOB_OPTIONS,
  });
  queue.on('error', () => {
    // The caller logs connection failures when an operation rejects.
  });

  return {
    redis: connection,
    prefix,
    async addRepeatable(jobId, everyMs) {
      await queue.add(
        'tick',
        { type: 'tick', jobId },
        {
          ...JOB_OPTIONS,
          jobId,
          repeat: { every: everyMs, immediately: true },
        },
      );
    },
    async removeRepeatable(jobId, everyMs) {
      await queue.removeRepeatable('tick', { every: everyMs }, jobId).catch(() => false);
    },
    async addStarter(jobId, startTime) {
      const delay = Math.max(0, startTime.getTime() - Date.now());
      await queue.add(
        'start',
        { type: 'start', jobId },
        { ...JOB_OPTIONS, jobId: `start-${jobId}`, delay },
      );
    },
    async removeStarter(jobId) {
      const existing = await queue.getJob(`start-${jobId}`);
      if (existing) {
        await existing.remove().catch(() => undefined);
      }
    },
    async enqueueInject(job) {
      await queue.add(
        'inject',
        { type: 'inject', ...job },
        { ...JOB_OPTIONS, jobId: `inject-${job.jobId}-${randomUUID()}` },
      );
    },
    async claimInjectSlot(jobId, limit = 10) {
      const key = `inject-rate:${jobId}`;
      const count = await connection.incr(key);
      if (count === 1) {
        await connection.expire(key, 60);
      }
      const ttl = await connection.ttl(key);
      if (ttl < 0) {
        await connection.expire(key, 60);
      }
      return count <= limit;
    },
    async listRepeatables() {
      const jobs = await queue.getRepeatableJobs();
      return jobs.map((job) => ({
        ...(job.id ? { id: job.id } : {}),
        key: job.key,
        name: job.name,
      }));
    },
    async reset() {
      await queue.obliterate({ force: true });
    },
    async close() {
      await queue.close();
      await connection.quit();
    },
  };
}
