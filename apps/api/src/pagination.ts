import { listQuerySchema } from '@fireweave/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ListCursor = {
  createdAt: Date;
  id: string;
};

export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryError';
  }
}

export function parseListQuery(query: unknown): { limit: number; cursor: ListCursor | null } {
  const parsed = listQuerySchema.safeParse(query ?? {});
  if (!parsed.success) {
    throw new QueryError('Invalid request');
  }
  if (!parsed.data.cursor) {
    return { limit: parsed.data.limit, cursor: null };
  }
  const cursor = decodeCursor(parsed.data.cursor);
  if (!cursor) {
    throw new QueryError('Invalid request');
  }
  return { limit: parsed.data.limit, cursor };
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(value: string): ListCursor | null {
  try {
    const text = Buffer.from(value, 'base64url').toString('utf8');
    const splitAt = text.indexOf('|');
    if (splitAt <= 0) {
      return null;
    }
    const createdAt = new Date(text.slice(0, splitAt));
    const id = text.slice(splitAt + 1);
    if (Number.isNaN(createdAt.getTime()) || !UUID.test(id)) {
      return null;
    }
    return { createdAt, id };
  } catch {
    return null;
  }
}

export function createdAtCursorWhere(cursor: ListCursor | null) {
  if (!cursor) {
    return {};
  }
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { AND: [{ createdAt: cursor.createdAt }, { id: { lt: cursor.id } }] },
    ],
  };
}

export function pageResult<T extends { createdAt: Date; id: string }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null;
  return { items, nextCursor };
}
