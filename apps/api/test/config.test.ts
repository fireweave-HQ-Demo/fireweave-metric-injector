import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const encryptionKey = Buffer.alloc(32, 7).toString('base64');

function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://fireweave:fireweave@localhost:5432/fireweave_test',
    REDIS_URL: 'redis://localhost:6379',
    ENCRYPTION_KEY: encryptionKey,
    JWT_ACCESS_SECRET: 'test-access-secret-must-be-32-characters',
    JWT_REFRESH_SECRET: 'test-refresh-secret-must-be-32-characters',
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('rejects a missing encryption key', () => {
    expect(() => loadConfig(validEnv({ ENCRYPTION_KEY: undefined }))).toThrow(/ENCRYPTION_KEY/);
  });

  it('rejects an encryption key that is not 32 bytes', () => {
    expect(() => loadConfig(validEnv({ ENCRYPTION_KEY: 'aaaa' }))).toThrow(/32 bytes/);
  });

  it('rejects a missing access-token secret', () => {
    expect(() => loadConfig(validEnv({ JWT_ACCESS_SECRET: undefined }))).toThrow(
      /JWT_ACCESS_SECRET/,
    );
  });

  it('requires CORS origins in production', () => {
    expect(() => loadConfig(validEnv({ NODE_ENV: 'production', CORS_ORIGINS: '' }))).toThrow(
      /CORS_ORIGINS/,
    );
    const config = loadConfig(
      validEnv({ NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example' }),
    );
    expect(config.corsOrigins).toEqual(['https://app.example']);
  });

  it('accepts a 32-byte key outside production without CORS origins', () => {
    const config = loadConfig(validEnv());
    expect(config.encryptionKey).toHaveLength(32);
    expect(config.authRateLimitMax).toBe(5);
    expect(config.apiRateLimitMax).toBe(100);
    expect(config.corsOrigins).toEqual([]);
  });
});
