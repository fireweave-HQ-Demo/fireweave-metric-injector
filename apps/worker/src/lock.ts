import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { recordLockLost } from './metrics.js';

const RELEASE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export function lockTtlSeconds(tickIntervalMs: number): number {
  return Math.min(60, Math.max(2, Math.ceil((2 * tickIntervalMs) / 1000)));
}

export function tickDeadlineAt(tickIntervalMs: number, startedAt = Date.now()): number {
  const budget = 0.8 * tickIntervalMs;
  const beforeLockExpires = lockTtlSeconds(tickIntervalMs) * 1000 - 1000;
  return startedAt + Math.min(budget, Math.max(0, beforeLockExpires));
}

export function lockKey(jobId: string): string {
  return `tick:${jobId}`;
}

export async function acquireLock(
  redis: Redis,
  jobId: string,
  tickIntervalMs: number,
): Promise<{ owner: string } | null> {
  const owner = randomUUID();
  const result = await redis.set(lockKey(jobId), owner, 'EX', lockTtlSeconds(tickIntervalMs), 'NX');
  return result === 'OK' ? { owner } : null;
}

export async function releaseLock(redis: Redis, jobId: string, owner: string): Promise<void> {
  const released = await redis.eval(RELEASE, 1, lockKey(jobId), owner);
  if (Number(released) !== 1) {
    recordLockLost();
  }
}
