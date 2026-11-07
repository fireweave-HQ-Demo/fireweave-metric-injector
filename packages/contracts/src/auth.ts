import { z } from 'zod';

export const credentialsSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128),
});

export type Credentials = z.infer<typeof credentialsSchema>;
