import {
  createVendorAccountSchema,
  updateVendorAccountSchema,
  type CreateVendorAccount,
  type UpdateVendorAccount,
} from '@fireweave/contracts';
import { writeAudit, type Database } from '@fireweave/db';
import {
  createFetchHttp,
  createVendorAdapter,
  credentialDescriptor,
  CryptoError,
  decryptJson,
  encryptJson,
  normalizeVendorCredentials,
  VendorInputError,
  type VendorCredentials,
  type VendorHttp,
} from '@fireweave/core';
import { createdAtCursorWhere, encodeCursor } from '../pagination.js';

const BLOCKING_JOB_STATUSES = ['scheduled', 'active', 'paused'] as const;

export class AccountError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

export type VendorAccountDto = {
  id: string;
  label: string;
  vendorType: 'openobserve' | 'datadog' | 'sentry';
  credentialHint: string;
  credentialKind: 'api_key' | 'token' | 'email' | 'dsn_key';
  validatedAt: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type AccountRow = {
  id: string;
  label: string;
  vendorType: VendorAccountDto['vendorType'];
  credentialHint: string;
  credentialKind: VendorAccountDto['credentialKind'];
  validatedAt: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export function createVendorService(deps: {
  db: Database;
  encryptionKey: Buffer;
  http?: VendorHttp;
}) {
  const http = deps.http ?? createFetchHttp();

  return {
    async create(userId: string, body: unknown): Promise<VendorAccountDto> {
      const parsed = parseBody(createVendorAccountSchema, body);
      const credentials = normalize(toVendorCredentials(parsed));
      await assertAccepted(credentials, http);
      const descriptor = credentialDescriptor(credentials);
      const row = await deps.db.vendorAccount.create({
        data: {
          userId,
          vendorType: credentials.vendorType,
          label: parsed.label,
          credentialsCipher: asBytes(encryptJson(credentials, deps.encryptionKey)),
          credentialHint: descriptor.credentialHint,
          credentialKind: descriptor.credentialKind,
          validatedAt: new Date(),
        },
        select: accountSelect,
      });
      await writeAudit(deps.db, {
        userId,
        action: 'vendor_account.created',
        entityType: 'vendor_account',
        entityId: row.id,
        metadata: { vendorType: credentials.vendorType, label: parsed.label },
      });
      return toDto(row);
    },

    async list(
      userId: string,
      query: { limit: number; cursor: { createdAt: Date; id: string } | null },
    ): Promise<{ items: VendorAccountDto[]; nextCursor: string | null }> {
      const rows = await deps.db.vendorAccount.findMany({
        where: { userId, deletedAt: null, ...createdAtCursorWhere(query.cursor) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        select: accountSelect,
      });
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(toDto),
        nextCursor:
          rows.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    },

    async update(userId: string, id: string, body: unknown): Promise<VendorAccountDto> {
      const parsed = parseBody(updateVendorAccountSchema, body);
      const existing = await findOwned(deps.db, userId, id);
      const data: {
        label?: string;
        isActive?: boolean;
        credentialsCipher?: Uint8Array<ArrayBuffer>;
        credentialHint?: string;
        credentialKind?: VendorAccountDto['credentialKind'];
        validatedAt?: Date;
      } = {};
      if (parsed.label !== undefined) {
        data.label = parsed.label;
      }
      if (parsed.isActive !== undefined) {
        data.isActive = parsed.isActive;
      }
      if (parsed.credentials) {
        const credentials = normalize(
          toVendorCredentials({
            vendorType: existing.vendorType,
            label: existing.label,
            credentials: parsed.credentials,
          }),
        );
        if (credentials.vendorType !== existing.vendorType) {
          throw new AccountError(400, 'VALIDATION', 'Credentials do not match this vendor');
        }
        await assertAccepted(credentials, http);
        const descriptor = credentialDescriptor(credentials);
        data.credentialsCipher = asBytes(encryptJson(credentials, deps.encryptionKey));
        data.credentialHint = descriptor.credentialHint;
        data.credentialKind = descriptor.credentialKind;
        data.validatedAt = new Date();
      }
      const row = await deps.db.vendorAccount.update({
        where: { id: existing.id },
        data,
        select: accountSelect,
      });
      await writeAudit(deps.db, {
        userId,
        action: 'vendor_account.updated',
        entityType: 'vendor_account',
        entityId: row.id,
        metadata: { credentialsReplaced: parsed.credentials !== undefined },
      });
      return toDto(row);
    },

    async remove(userId: string, id: string): Promise<void> {
      const existing = await findOwned(deps.db, userId, id);
      const blocking = await deps.db.ingestionJob.count({
        where: {
          deletedAt: null,
          status: { in: [...BLOCKING_JOB_STATUSES] },
          accounts: { some: { vendorAccountId: existing.id } },
        },
      });
      if (blocking > 0) {
        throw new AccountError(
          409,
          'CONFLICT',
          'Vendor account is used by a job that is still scheduled, active, or paused',
        );
      }
      await deps.db.vendorAccount.update({
        where: { id: existing.id },
        data: { deletedAt: new Date(), credentialsCipher: new Uint8Array() },
      });
      await writeAudit(deps.db, {
        userId,
        action: 'vendor_account.deleted',
        entityType: 'vendor_account',
        entityId: existing.id,
      });
    },

    async revalidate(userId: string, id: string): Promise<VendorAccountDto> {
      const existing = await deps.db.vendorAccount.findFirst({
        where: { id, userId, deletedAt: null },
      });
      if (!existing) {
        throw new AccountError(404, 'NOT_FOUND', 'Vendor account not found');
      }
      const credentials = readCredentials(existing.credentialsCipher, deps.encryptionKey);
      await assertAccepted(credentials, http);
      const row = await deps.db.vendorAccount.update({
        where: { id: existing.id },
        data: { validatedAt: new Date() },
        select: accountSelect,
      });
      return toDto(row);
    },
  };
}

const accountSelect = {
  id: true,
  label: true,
  vendorType: true,
  credentialHint: true,
  credentialKind: true,
  validatedAt: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function findOwned(db: Database, userId: string, id: string) {
  const existing = await db.vendorAccount.findFirst({
    where: { id, userId, deletedAt: null },
    select: { id: true, vendorType: true, label: true },
  });
  if (!existing) {
    throw new AccountError(404, 'NOT_FOUND', 'Vendor account not found');
  }
  return existing;
}

function parseBody<T>(
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  body: unknown,
): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AccountError(400, 'VALIDATION', 'Invalid request');
  }
  return parsed.data;
}

function toVendorCredentials(
  input:
    | CreateVendorAccount
    | {
        vendorType: VendorAccountDto['vendorType'];
        label: string;
        credentials: UpdateVendorAccount['credentials'];
      },
): VendorCredentials {
  if (!input.credentials) {
    throw new AccountError(400, 'VALIDATION', 'Invalid request');
  }
  if (input.vendorType === 'openobserve') {
    if (!('baseUrl' in input.credentials)) {
      throw new AccountError(400, 'VALIDATION', 'Credentials do not match this vendor');
    }
    return { vendorType: 'openobserve', credentials: input.credentials };
  }
  if (input.vendorType === 'datadog') {
    if (!('apiKey' in input.credentials)) {
      throw new AccountError(400, 'VALIDATION', 'Credentials do not match this vendor');
    }
    return { vendorType: 'datadog', credentials: input.credentials };
  }
  if (!('dsn' in input.credentials)) {
    throw new AccountError(400, 'VALIDATION', 'Credentials do not match this vendor');
  }
  return { vendorType: 'sentry', credentials: input.credentials };
}

function normalize(credentials: VendorCredentials): VendorCredentials {
  try {
    return normalizeVendorCredentials(credentials);
  } catch (error) {
    if (error instanceof VendorInputError) {
      throw new AccountError(400, 'VALIDATION', error.message);
    }
    throw error;
  }
}

async function assertAccepted(credentials: VendorCredentials, http: VendorHttp): Promise<void> {
  const adapter = createVendorAdapter({ accountId: 'pending', credentials, http });
  try {
    const accepted = await adapter.validateCredentials();
    if (!accepted) {
      throw new AccountError(422, 'VENDOR_REJECTED', 'Vendor credentials were rejected');
    }
  } catch (error) {
    if (error instanceof AccountError || error instanceof VendorInputError) {
      if (error instanceof VendorInputError) {
        throw new AccountError(400, 'VALIDATION', error.message);
      }
      throw error;
    }
    throw new AccountError(422, 'VENDOR_REJECTED', 'Vendor credentials could not be verified');
  }
}

function readCredentials(payload: Uint8Array, key: Buffer): VendorCredentials {
  try {
    const parsed = decryptJson(Buffer.from(payload), key);
    if (!isVendorCredentials(parsed)) {
      throw new CryptoError('Ciphertext is not vendor credentials');
    }
    return parsed;
  } catch (error) {
    if (error instanceof AccountError) {
      throw error;
    }
    throw new AccountError(422, 'VENDOR_REJECTED', 'Vendor credentials could not be verified');
  }
}

function isVendorCredentials(value: unknown): value is VendorCredentials {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as { vendorType?: unknown; credentials?: unknown };
  return (
    (record.vendorType === 'openobserve' ||
      record.vendorType === 'datadog' ||
      record.vendorType === 'sentry') &&
    typeof record.credentials === 'object' &&
    record.credentials !== null
  );
}

function asBytes(value: Buffer): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  return bytes;
}

function toDto(row: AccountRow): VendorAccountDto {
  return {
    id: row.id,
    label: row.label,
    vendorType: row.vendorType,
    credentialHint: row.credentialHint,
    credentialKind: row.credentialKind,
    validatedAt: row.validatedAt.toISOString(),
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
