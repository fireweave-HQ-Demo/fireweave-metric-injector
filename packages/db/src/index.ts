import { PrismaClient } from '@prisma/client';

export { Prisma, PrismaClient } from '@prisma/client';

export function createPrismaClient(databaseUrl: string) {
  return new PrismaClient({
    datasources: {
      db: { url: databaseUrl },
    },
  });
}

export type Database = ReturnType<typeof createPrismaClient>;

export { writeAudit } from './audit.js';
