import { readFileSync } from 'node:fs';
import argon2 from 'argon2';

const ARGON_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

const MIN_LENGTH = 12;
const MAX_LENGTH = 128;

export class PasswordRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordRejectedError';
  }
}

export function loadDenylist(path: string): Set<string> {
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const entries = new Set<string>();
  for (const line of text.split('\n')) {
    const value = line.trim().toLowerCase();
    if (value.length > 0) {
      entries.add(value);
    }
  }
  return entries;
}

export function assertPasswordAcceptable(password: string, denylist: Set<string>): void {
  if (password.length < MIN_LENGTH || password.length > MAX_LENGTH) {
    throw new PasswordRejectedError(
      `Password must be between ${MIN_LENGTH} and ${MAX_LENGTH} characters`,
    );
  }
  if (denylist.has(password.toLowerCase())) {
    throw new PasswordRejectedError('Password is too common');
  }
}

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
