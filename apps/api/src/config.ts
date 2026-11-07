import { parseEnv, type ParsedEnv } from '@fireweave/contracts';
import { fileURLToPath } from 'node:url';

export const defaultDenylistPath = fileURLToPath(
  new URL('../../../data/password-denylist.txt', import.meta.url),
);

export type Config = {
  nodeEnv: ParsedEnv['NODE_ENV'];
  port: number;
  databaseUrl: string;
  redisUrl: string;
  encryptionKey: Buffer;
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  authRateLimitMax: number;
  apiRateLimitMax: number;
  passwordDenylistPath: string;
  corsOrigins: string[];
};

export function loadConfig(source: Record<string, string | undefined>): Config {
  const env = parseEnv(source);
  const encryptionKey = decodeEncryptionKey(env.ENCRYPTION_KEY);
  const corsOrigins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (env.NODE_ENV === 'production' && corsOrigins.length === 0) {
    throw new Error('CORS_ORIGINS is required when NODE_ENV is production');
  }

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    encryptionKey,
    jwtAccessSecret: env.JWT_ACCESS_SECRET,
    jwtRefreshSecret: env.JWT_REFRESH_SECRET,
    authRateLimitMax: env.AUTH_RATE_LIMIT_MAX,
    apiRateLimitMax: env.API_RATE_LIMIT_MAX,
    passwordDenylistPath: env.PASSWORD_DENYLIST_PATH ?? defaultDenylistPath,
    corsOrigins,
  };
}

function decodeEncryptionKey(value: string): Buffer {
  const trimmed = value.trim();
  const decoded = Buffer.from(trimmed, 'base64');
  const canonical = decoded.toString('base64').replace(/=+$/, '');
  const given = trimmed.replace(/=+$/, '');
  if (decoded.length !== 32 || canonical !== given) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes encoded as base64');
  }
  return decoded;
}
