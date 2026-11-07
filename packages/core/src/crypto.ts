import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

export function encryptBytes(plaintext: Buffer, key: Buffer, iv = randomBytes(IV_LENGTH)): Buffer {
  assertKey(key);
  if (iv.length !== IV_LENGTH) {
    throw new CryptoError('IV must be 12 bytes');
  }
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_LENGTH) {
    throw new CryptoError('Auth tag must be 16 bytes');
  }
  return Buffer.concat([iv, tag, ciphertext]);
}

export function decryptBytes(payload: Buffer, key: Buffer): Buffer {
  assertKey(key);
  if (payload.length < IV_LENGTH + TAG_LENGTH) {
    throw new CryptoError('Ciphertext is too short');
  }
  const iv = payload.subarray(0, IV_LENGTH);
  const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new CryptoError('Ciphertext failed authentication');
  }
}

export function encryptJson(value: unknown, key: Buffer): Buffer {
  return encryptBytes(Buffer.from(JSON.stringify(value), 'utf8'), key);
}

export function decryptJson(payload: Buffer, key: Buffer): unknown {
  const plaintext = decryptBytes(payload, key).toString('utf8');
  try {
    return JSON.parse(plaintext) as unknown;
  } catch {
    throw new CryptoError('Ciphertext is not JSON');
  }
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) {
    throw new CryptoError('Encryption key must be 32 bytes');
  }
}
