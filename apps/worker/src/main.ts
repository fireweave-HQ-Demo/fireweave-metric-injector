import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrismaClient } from '@fireweave/db';
import { createFetchHttp } from '@fireweave/core';
import { startIngestionWorker } from './worker.js';
import { loadWorkerConfig } from './config.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
loadDotenv({ path: resolve(repoRoot, '.env') });

const config = loadWorkerConfig(process.env);
const db = createPrismaClient(config.databaseUrl);
const worker = await startIngestionWorker({
  redisUrl: config.redisUrl,
  db,
  encryptionKey: config.encryptionKey,
  http: createFetchHttp(),
  metricsPort: config.metricsPort,
});

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  await worker.shutdown();
  await db.$disconnect();
}

process.on('SIGTERM', () => {
  stop()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
});
process.on('SIGINT', () => {
  stop()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
});
