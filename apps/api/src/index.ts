import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJobScheduler } from '@fireweave/queue';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
loadDotenv({ path: resolve(repoRoot, '.env') });

const config = loadConfig(process.env);
const queue = createJobScheduler(config.redisUrl);
const app = await buildApp(config, { queue });

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
