import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  ENCRYPTION_KEY: z.string().min(1),
  WORKER_METRICS_PORT: z.coerce.number().int().positive().default(3001),
});

export type WorkerConfig = {
  databaseUrl: string;
  redisUrl: string;
  encryptionKey: Buffer;
  metricsPort: number;
};

export function loadWorkerConfig(source: Record<string, string | undefined>): WorkerConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new Error('Invalid worker environment');
  }
  const key = Buffer.from(parsed.data.ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes of base64');
  }
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    redisUrl: parsed.data.REDIS_URL,
    encryptionKey: key,
    metricsPort: parsed.data.WORKER_METRICS_PORT,
  };
}
