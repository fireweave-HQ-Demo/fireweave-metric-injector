import { z } from 'zod';

const nameSchema = z.string().trim().min(1).max(120);
const metricNameSchema = z.string().trim().min(1).max(128);
const probabilitySchema = z.number().finite().min(0).max(1);
const dateTimeSchema = z.string().datetime({ offset: true });

export const metricDefinitionSchema = z
  .object({
    name: metricNameSchema,
    type: z.enum(['counter', 'gauge', 'histogram']),
    category: z.enum(['success', 'error', 'custom', 'dependent']),
    tags: z.record(z.string(), z.string()).default({}),
    dependsOn: z.array(metricNameSchema).max(32).default([]),
    formula: z.string().trim().min(1).max(2000).nullable().default(null),
    successProbability: probabilitySchema.nullable().default(null),
    errorProbability: probabilitySchema.nullable().default(null),
  })
  .strict();

export const createJobSchema = z
  .object({
    name: nameSchema,
    timezone: z.string().trim().min(1).max(100),
    virtualUserCount: z.number().int().min(1).max(1_000_000),
    peakRatePerSecond: z.number().finite().positive().max(1_000_000),
    successProbability: probabilitySchema,
    errorProbability: probabilitySchema,
    tickIntervalMs: z.number().int().min(1000).max(30_000).default(1000),
    startTime: dateTimeSchema,
    endTime: dateTimeSchema.nullable().default(null),
    fanoutMode: z.literal('replicate').optional(),
    vendorAccountIds: z.array(z.string().uuid()).min(1).max(20),
    definitions: z.array(metricDefinitionSchema).min(1).max(100),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.successProbability + body.errorProbability > 1 + 1e-9) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'successProbability and errorProbability must sum to at most 1',
        path: ['successProbability'],
      });
    }
    if (body.endTime && Date.parse(body.endTime) <= Date.parse(body.startTime)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endTime must be after startTime',
        path: ['endTime'],
      });
    }
  });

export const updateJobSchema = z
  .object({
    name: nameSchema.optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
    virtualUserCount: z.number().int().min(1).max(1_000_000).optional(),
    peakRatePerSecond: z.number().finite().positive().max(1_000_000).optional(),
    successProbability: probabilitySchema.optional(),
    errorProbability: probabilitySchema.optional(),
    tickIntervalMs: z.number().int().min(1000).max(30_000).optional(),
    endTime: dateTimeSchema.nullable().optional(),
    vendorAccountIds: z.array(z.string().uuid()).min(1).max(20).optional(),
    definitions: z.array(metricDefinitionSchema).min(1).max(100).optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.name !== undefined ||
      body.timezone !== undefined ||
      body.virtualUserCount !== undefined ||
      body.peakRatePerSecond !== undefined ||
      body.successProbability !== undefined ||
      body.errorProbability !== undefined ||
      body.tickIntervalMs !== undefined ||
      body.endTime !== undefined ||
      body.vendorAccountIds !== undefined ||
      body.definitions !== undefined,
    { message: 'At least one field is required' },
  );

export const injectPointSchema = z
  .object({
    metricDefinitionId: z.string().uuid(),
    value: z.number().finite(),
    timestamp: dateTimeSchema.optional(),
  })
  .strict();

export type MetricDefinitionInput = z.infer<typeof metricDefinitionSchema>;
export type CreateJob = z.infer<typeof createJobSchema>;
export type UpdateJob = z.infer<typeof updateJobSchema>;
export type InjectPoint = z.infer<typeof injectPointSchema>;
