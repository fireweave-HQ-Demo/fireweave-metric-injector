import { z } from 'zod';

const labelSchema = z.string().trim().min(1).max(80);
const secretSchema = z.string().min(1).max(4096);

export const openObservePasswordSchema = z
  .object({
    baseUrl: z.string().trim().url().max(500),
    organization: z.string().trim().min(1).max(64),
    email: z.string().trim().email().max(254),
    password: secretSchema,
  })
  .strict();

export const openObserveTokenSchema = z
  .object({
    baseUrl: z.string().trim().url().max(500),
    organization: z.string().trim().min(1).max(64),
    token: secretSchema,
  })
  .strict();

export const datadogCredentialsSchema = z
  .object({
    apiKey: secretSchema,
    appKey: secretSchema,
    site: z.string().trim().min(1).max(253),
  })
  .strict();

export const sentryCredentialsSchema = z
  .object({
    dsn: z.string().trim().min(1).max(500),
    organization: z.string().trim().min(1).max(64),
    project: z.string().trim().min(1).max(64),
    orgAuthToken: secretSchema,
  })
  .strict();

export const createVendorAccountSchema = z.discriminatedUnion('vendorType', [
  z.object({
    vendorType: z.literal('openobserve'),
    label: labelSchema,
    credentials: z.union([openObservePasswordSchema, openObserveTokenSchema]),
  }),
  z.object({
    vendorType: z.literal('datadog'),
    label: labelSchema,
    credentials: datadogCredentialsSchema,
  }),
  z.object({
    vendorType: z.literal('sentry'),
    label: labelSchema,
    credentials: sentryCredentialsSchema,
  }),
]);

export const updateVendorAccountSchema = z
  .object({
    label: labelSchema.optional(),
    isActive: z.boolean().optional(),
    credentials: z
      .union([
        openObservePasswordSchema,
        openObserveTokenSchema,
        datadogCredentialsSchema,
        sentryCredentialsSchema,
      ])
      .optional(),
  })
  .refine(
    (body) =>
      body.label !== undefined || body.isActive !== undefined || body.credentials !== undefined,
    {
      message: 'At least one field is required',
    },
  );

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(500).optional(),
});

export type CreateVendorAccount = z.infer<typeof createVendorAccountSchema>;
export type UpdateVendorAccount = z.infer<typeof updateVendorAccountSchema>;
