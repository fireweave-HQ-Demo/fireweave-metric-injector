import {
  createJobSchema,
  injectPointSchema,
  updateJobSchema,
  type CreateJob,
  type UpdateJob,
} from '@fireweave/contracts';
import type { JobScheduler } from '@fireweave/queue';
import { Prisma, writeAudit, type Database } from '@fireweave/db';
import {
  MetricDefinitionError,
  prepareDefinitions,
  type MetricDraft,
  type PreparedMetric,
} from '@fireweave/core';

export class JobError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'JobError';
  }
}

export type JobDto = {
  id: string;
  name: string;
  status: 'scheduled' | 'active' | 'paused' | 'completed' | 'failed';
  fanoutMode: 'replicate' | 'split';
  timezone: string;
  virtualUserCount: number;
  peakRatePerSecond: number;
  successProbability: number;
  errorProbability: number;
  tickIntervalMs: number;
  startTime: string;
  endTime: string | null;
  lastSimulatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  vendorAccountIds: string[];
  definitions: MetricDefinitionDto[];
  failures: FailureDto[];
};

export type MetricDefinitionDto = {
  id: string;
  name: string;
  type: 'counter' | 'gauge' | 'histogram';
  category: 'success' | 'error' | 'custom' | 'dependent';
  tags: Record<string, string>;
  dependsOn: string[];
  formula: string | null;
  evalOrder: number;
  successProbability: number | null;
  errorProbability: number | null;
};

export type FailureDto = {
  id: string;
  reason: string;
  payload: Prisma.JsonValue;
  vendorAccountId: string | null;
  deliveryId: string | null;
  createdAt: string;
};

const jobInclude = {
  definitions: { orderBy: { evalOrder: 'asc' as const } },
  accounts: { orderBy: { vendorAccountId: 'asc' as const }, select: { vendorAccountId: true } },
  failures: { orderBy: { createdAt: 'desc' as const }, take: 20 },
} satisfies Prisma.IngestionJobInclude;

export function createJobService(db: Database, queue?: JobScheduler) {
  return {
    async create(userId: string, body: unknown): Promise<JobDto> {
      const parsed = parseBody(createJobSchema, body);
      assertTimezone(parsed.timezone);
      const accounts = await loadAccounts(db, userId, parsed.vendorAccountIds);
      const definitions = compile(parsed.definitions);
      const startTime = new Date(parsed.startTime);
      const job = await db.ingestionJob.create({
        data: {
          userId,
          name: parsed.name,
          status: startTime.getTime() <= Date.now() ? 'active' : 'scheduled',
          fanoutMode: 'replicate',
          timezone: parsed.timezone,
          virtualUserCount: parsed.virtualUserCount,
          peakRatePerSecond: parsed.peakRatePerSecond,
          successProbability: parsed.successProbability,
          errorProbability: parsed.errorProbability,
          tickIntervalMs: parsed.tickIntervalMs,
          startTime,
          endTime: parsed.endTime ? new Date(parsed.endTime) : null,
          accounts: { create: accounts.map((vendorAccountId) => ({ vendorAccountId })) },
          definitions: { create: definitions.map(definitionData) },
        },
        include: jobInclude,
      });
      if (queue) {
        if (job.status === 'active') {
          await queue.addRepeatable(job.id, job.tickIntervalMs);
        } else {
          await queue.addStarter(job.id, job.startTime);
        }
      }
      await writeAudit(db, {
        userId,
        action: 'job.created',
        entityType: 'job',
        entityId: job.id,
        metadata: { name: job.name, status: job.status },
      });
      return toDto(job);
    },

    async get(userId: string, id: string): Promise<JobDto> {
      const job = await db.ingestionJob.findFirst({
        where: { id, userId, deletedAt: null },
        include: jobInclude,
      });
      if (!job) {
        throw new JobError(404, 'NOT_FOUND', 'Job not found');
      }
      return toDto(job);
    },

    async update(userId: string, id: string, body: unknown): Promise<JobDto> {
      const parsed = parseBody(updateJobSchema, body);
      const existing = await db.ingestionJob.findFirst({
        where: { id, userId, deletedAt: null },
      });
      if (!existing) {
        throw new JobError(404, 'NOT_FOUND', 'Job not found');
      }
      if (parsed.timezone !== undefined) {
        assertTimezone(parsed.timezone);
      }
      const structural = parsed.definitions !== undefined || parsed.vendorAccountIds !== undefined;
      if (structural && existing.status === 'active') {
        throw new JobError(
          409,
          'CONFLICT',
          'Definitions and vendor accounts cannot change while the job is active',
        );
      }
      const successProbability = parsed.successProbability ?? existing.successProbability;
      const errorProbability = parsed.errorProbability ?? existing.errorProbability;
      if (successProbability + errorProbability > 1 + 1e-9) {
        throw new JobError(
          400,
          'VALIDATION',
          'successProbability and errorProbability must sum to at most 1',
        );
      }
      const endTime =
        parsed.endTime === undefined
          ? undefined
          : parsed.endTime === null
            ? null
            : new Date(parsed.endTime);
      if (endTime && endTime.getTime() <= existing.startTime.getTime()) {
        throw new JobError(400, 'VALIDATION', 'endTime must be after startTime');
      }
      const definitions = parsed.definitions ? compile(parsed.definitions) : null;
      const accounts = parsed.vendorAccountIds
        ? await loadAccounts(db, userId, parsed.vendorAccountIds)
        : null;

      await db.$transaction(async (tx) => {
        await tx.ingestionJob.update({
          where: { id: existing.id },
          data: {
            ...(parsed.name !== undefined ? { name: parsed.name } : {}),
            ...(parsed.timezone !== undefined ? { timezone: parsed.timezone } : {}),
            ...(parsed.virtualUserCount !== undefined
              ? { virtualUserCount: parsed.virtualUserCount }
              : {}),
            ...(parsed.peakRatePerSecond !== undefined
              ? { peakRatePerSecond: parsed.peakRatePerSecond }
              : {}),
            ...(parsed.successProbability !== undefined ? { successProbability } : {}),
            ...(parsed.errorProbability !== undefined ? { errorProbability } : {}),
            ...(parsed.tickIntervalMs !== undefined
              ? { tickIntervalMs: parsed.tickIntervalMs }
              : {}),
            ...(endTime !== undefined ? { endTime } : {}),
          },
        });
        if (definitions) {
          await tx.metricDefinition.deleteMany({ where: { jobId: existing.id } });
          await tx.metricDefinition.createMany({
            data: definitions.map((definition) => ({
              jobId: existing.id,
              ...definitionData(definition),
            })),
          });
        }
        if (accounts) {
          await tx.jobVendorAccount.deleteMany({ where: { jobId: existing.id } });
          await tx.jobVendorAccount.createMany({
            data: accounts.map((vendorAccountId) => ({ jobId: existing.id, vendorAccountId })),
          });
        }
      });

      if (
        queue &&
        existing.status === 'active' &&
        parsed.tickIntervalMs !== undefined &&
        parsed.tickIntervalMs !== existing.tickIntervalMs
      ) {
        await queue.removeRepeatable(existing.id, existing.tickIntervalMs);
        await queue.addRepeatable(existing.id, parsed.tickIntervalMs);
      }
      return this.get(userId, existing.id);
    },

    async pause(userId: string, id: string): Promise<JobDto> {
      const existing = await owned(db, userId, id);
      if (existing.status !== 'scheduled' && existing.status !== 'active') {
        throw new JobError(409, 'CONFLICT', 'Only a scheduled or active job can be paused');
      }
      if (queue) {
        await queue.removeStarter(existing.id);
        await queue.removeRepeatable(existing.id, existing.tickIntervalMs);
      }
      const updated = await db.ingestionJob.updateMany({
        where: { id: existing.id, status: { in: ['scheduled', 'active'] }, deletedAt: null },
        data: { status: 'paused' },
      });
      if (updated.count === 0) {
        throw new JobError(409, 'CONFLICT', 'Only a scheduled or active job can be paused');
      }
      await writeAudit(db, {
        userId,
        action: 'job.paused',
        entityType: 'job',
        entityId: existing.id,
      });
      return this.get(userId, existing.id);
    },

    async resume(userId: string, id: string): Promise<JobDto> {
      const existing = await owned(db, userId, id);
      if (existing.status !== 'paused') {
        throw new JobError(409, 'CONFLICT', 'Only a paused job can be resumed');
      }
      const startInFuture = existing.startTime.getTime() > Date.now();
      const updated = await db.ingestionJob.updateMany({
        where: { id: existing.id, status: 'paused', deletedAt: null },
        data: { status: startInFuture ? 'scheduled' : 'active' },
      });
      if (updated.count === 0) {
        throw new JobError(409, 'CONFLICT', 'Only a paused job can be resumed');
      }
      if (queue) {
        if (startInFuture) {
          await queue.addStarter(existing.id, existing.startTime);
        } else {
          await queue.addRepeatable(existing.id, existing.tickIntervalMs);
        }
      }
      await writeAudit(db, {
        userId,
        action: 'job.resumed',
        entityType: 'job',
        entityId: existing.id,
        metadata: { status: startInFuture ? 'scheduled' : 'active' },
      });
      return this.get(userId, existing.id);
    },

    async remove(userId: string, id: string): Promise<void> {
      const existing = await owned(db, userId, id);
      if (queue) {
        await queue.removeStarter(existing.id);
        await queue.removeRepeatable(existing.id, existing.tickIntervalMs);
      }
      const updated = await db.ingestionJob.updateMany({
        where: { id: existing.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (updated.count === 0) {
        throw new JobError(404, 'NOT_FOUND', 'Job not found');
      }
      await writeAudit(db, {
        userId,
        action: 'job.deleted',
        entityType: 'job',
        entityId: existing.id,
      });
    },

    async inject(userId: string, id: string, body: unknown): Promise<{ timestamp: string }> {
      const parsed = parseBody(injectPointSchema, body);
      const existing = await owned(db, userId, id);
      const definition = await db.metricDefinition.findFirst({
        where: { id: parsed.metricDefinitionId, jobId: existing.id },
        select: { id: true },
      });
      if (!definition) {
        throw new JobError(404, 'NOT_FOUND', 'Metric definition not found');
      }
      const timestamp = parsed.timestamp ? new Date(parsed.timestamp) : new Date();
      const now = Date.now();
      if (timestamp.getTime() < now - 60 * 60 * 1000 || timestamp.getTime() > now + 5000) {
        throw new JobError(
          400,
          'VALIDATION',
          'Timestamp must fall within the last hour and not more than 5 seconds ahead',
        );
      }
      if (!queue) {
        throw new JobError(500, 'INTERNAL', 'Ingestion queue is not configured');
      }
      const allowed = await queue.claimInjectSlot(existing.id);
      if (!allowed) {
        throw new JobError(429, 'RATE_LIMITED', 'Too many requests');
      }
      await queue.enqueueInject({
        jobId: existing.id,
        metricDefinitionId: definition.id,
        value: parsed.value,
        timestamp: timestamp.toISOString(),
      });
      await writeAudit(db, {
        userId,
        action: 'job.injected',
        entityType: 'job',
        entityId: existing.id,
        metadata: { metricDefinitionId: definition.id },
      });
      return { timestamp: timestamp.toISOString() };
    },
  };
}

async function owned(db: Database, userId: string, id: string) {
  const existing = await db.ingestionJob.findFirst({ where: { id, userId, deletedAt: null } });
  if (!existing) {
    throw new JobError(404, 'NOT_FOUND', 'Job not found');
  }
  return existing;
}

function compile(
  definitions: CreateJob['definitions'] | NonNullable<UpdateJob['definitions']>,
): PreparedMetric[] {
  try {
    return prepareDefinitions(definitions.map(toDraft));
  } catch (error) {
    if (error instanceof MetricDefinitionError) {
      throw new JobError(400, 'VALIDATION', error.message);
    }
    throw error;
  }
}

function toDraft(definition: CreateJob['definitions'][number]): MetricDraft {
  return {
    name: definition.name,
    type: definition.type,
    category: definition.category,
    tags: definition.tags,
    dependsOn: definition.dependsOn,
    formula: definition.formula,
    successProbability: definition.successProbability,
    errorProbability: definition.errorProbability,
  };
}

function definitionData(definition: PreparedMetric) {
  return {
    name: definition.name,
    type: definition.type,
    category: definition.category,
    tags: definition.tags,
    dependsOn: definition.dependsOn,
    formula: definition.formula,
    evalOrder: definition.evalOrder,
    successProbability: definition.successProbability,
    errorProbability: definition.errorProbability,
  };
}

async function loadAccounts(db: Database, userId: string, ids: string[]): Promise<string[]> {
  if (new Set(ids).size !== ids.length) {
    throw new JobError(400, 'VALIDATION', 'Vendor accounts must be unique');
  }
  const rows = await db.vendorAccount.findMany({
    where: { userId, deletedAt: null, id: { in: ids } },
    select: { id: true },
  });
  if (rows.length !== ids.length) {
    throw new JobError(400, 'VALIDATION', 'One or more vendor accounts are not available');
  }
  return [...ids].sort();
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
  } catch {
    throw new JobError(400, 'VALIDATION', 'Invalid timezone');
  }
}

function parseBody<T>(
  schema: {
    safeParse: (
      value: unknown,
    ) =>
      | { success: true; data: T }
      | { success: false; error: { issues: Array<{ message: string }> } };
  },
  body: unknown,
): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new JobError(400, 'VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid request');
  }
  return parsed.data;
}

type JobRow = Prisma.IngestionJobGetPayload<{ include: typeof jobInclude }>;

function toDto(job: JobRow): JobDto {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    fanoutMode: job.fanoutMode,
    timezone: job.timezone,
    virtualUserCount: job.virtualUserCount,
    peakRatePerSecond: job.peakRatePerSecond,
    successProbability: job.successProbability,
    errorProbability: job.errorProbability,
    tickIntervalMs: job.tickIntervalMs,
    startTime: job.startTime.toISOString(),
    endTime: job.endTime ? job.endTime.toISOString() : null,
    lastSimulatedAt: job.lastSimulatedAt ? job.lastSimulatedAt.toISOString() : null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    vendorAccountIds: job.accounts.map((account) => account.vendorAccountId),
    definitions: job.definitions.map((definition) => ({
      id: definition.id,
      name: definition.name,
      type: definition.type,
      category: definition.category,
      tags: tagsFromJson(definition.tags),
      dependsOn: definition.dependsOn,
      formula: definition.formula,
      evalOrder: definition.evalOrder,
      successProbability: definition.successProbability,
      errorProbability: definition.errorProbability,
    })),
    failures: job.failures.map((failure) => ({
      id: failure.id,
      reason: failure.reason,
      payload: failure.payload,
      vendorAccountId: failure.vendorAccountId,
      deliveryId: failure.deliveryId,
      createdAt: failure.createdAt.toISOString(),
    })),
  };
}

function tagsFromJson(value: Prisma.JsonValue): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const tags: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      tags[key] = entry;
    }
  }
  return tags;
}
