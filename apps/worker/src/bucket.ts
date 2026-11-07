import type { Redis } from 'ioredis';
import type { VendorHttp } from '@fireweave/core';

const TAKE = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local data = redis.call('HMGET', key, 'tokens', 'updated')
local tokens = tonumber(data[1])
local updated = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  updated = now
end
local elapsed = now - updated
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + (elapsed / windowMs) * capacity)
if tokens >= cost then
  tokens = tokens - cost
  redis.call('HSET', key, 'tokens', tokens, 'updated', now)
  redis.call('PEXPIRE', key, math.ceil(windowMs * 2))
  return 0
end
local waitMs = math.ceil(((cost - tokens) / capacity) * windowMs)
redis.call('HSET', key, 'tokens', tokens, 'updated', now)
redis.call('PEXPIRE', key, math.ceil(windowMs * 2))
return waitMs
`;

export type BucketSpec = {
  capacity: number;
  windowMs: number;
};

export type VendorName = 'datadog' | 'openobserve' | 'sentry';

export class OutboundRateLimitError extends Error {
  constructor() {
    super('rate_limited');
    this.name = 'OutboundRateLimitError';
  }
}

export function defaultOutboundLimit(vendorType: VendorName): BucketSpec {
  if (vendorType === 'datadog') {
    return { capacity: 300, windowMs: 60_000 };
  }
  if (vendorType === 'openobserve') {
    return { capacity: 60, windowMs: 1_000 };
  }
  return { capacity: 20, windowMs: 1_000 };
}

export function outboundLimitKey(accountId: string): string {
  return `outbound-limit:${accountId}`;
}

export function bucketKey(accountId: string): string {
  return `outbound:${accountId}`;
}

export async function readOutboundLimit(
  redis: Redis,
  accountId: string,
  vendorType: VendorName,
): Promise<BucketSpec> {
  const raw = await redis.get(outboundLimitKey(accountId));
  if (!raw) {
    return defaultOutboundLimit(vendorType);
  }
  const [capacityText, windowText] = raw.split(',');
  const capacity = Number(capacityText);
  const windowMs = Number(windowText);
  if (!Number.isFinite(capacity) || !Number.isFinite(windowMs) || capacity <= 0 || windowMs <= 0) {
    return defaultOutboundLimit(vendorType);
  }
  return { capacity, windowMs };
}

export async function takeToken(
  redis: Redis,
  accountId: string,
  spec: BucketSpec,
  now = Date.now(),
): Promise<number> {
  const wait = await redis.eval(
    TAKE,
    1,
    bucketKey(accountId),
    String(spec.capacity),
    String(spec.windowMs),
    String(now),
    '1',
  );
  const parsed = Number(wait);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function limitVendorHttp(input: {
  http: VendorHttp;
  redis: Redis;
  accountId: string;
  vendorType: VendorName;
  deadlineAt: number;
  deadline: AbortSignal;
}): VendorHttp {
  return {
    async request(request) {
      const spec = await readOutboundLimit(input.redis, input.accountId, input.vendorType);
      const wait = await takeToken(input.redis, input.accountId, spec);
      if (wait > 0) {
        if (input.deadline.aborted || Date.now() + wait >= input.deadlineAt) {
          throw new OutboundRateLimitError();
        }
        await sleep(wait, input.deadline);
        const again = await takeToken(input.redis, input.accountId, spec);
        if (again > 0 || input.deadline.aborted) {
          throw new OutboundRateLimitError();
        }
      }
      return input.http.request(request);
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(reason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(reason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function reason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new OutboundRateLimitError();
}
