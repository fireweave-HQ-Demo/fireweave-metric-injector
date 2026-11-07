import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  ENCRYPTION_KEY: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  PASSWORD_DENYLIST_PATH: z.string().min(1).optional(),
  CORS_ORIGINS: z.string().optional(),
});

export type EnvInput = z.input<typeof envSchema>;
export type ParsedEnv = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): ParsedEnv {
  const entries = Object.entries(source).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const parsed = envSchema.safeParse(Object.fromEntries(entries));
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || 'env').join(', ');
    throw new Error(`Invalid environment: ${fields}`);
  }
  return parsed.data;
}
