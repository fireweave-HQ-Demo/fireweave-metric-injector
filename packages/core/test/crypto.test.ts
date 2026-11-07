import { describe, expect, it } from 'vitest';
import { decryptBytes, encryptBytes } from '../src/crypto.js';

const key = Buffer.alloc(32, 1);
const iv = Buffer.alloc(12, 2);
const plaintext = Buffer.from('fireweave');
const knownAnswer = Buffer.from('AgICAgICAgICAgICwiS8ivBcjGfjjbufvMhjamG/uyw9MqCLtg==', 'base64');

describe('AES-256-GCM', () => {
  it('matches the known answer and the iv || auth tag || ciphertext layout', () => {
    const payload = encryptBytes(plaintext, key, iv);
    expect(payload.equals(knownAnswer)).toBe(true);
    expect(payload.subarray(0, 12).equals(iv)).toBe(true);
    expect(payload.subarray(12, 28).equals(knownAnswer.subarray(12, 28))).toBe(true);
    expect(payload.subarray(28).length).toBe(plaintext.length);
    expect(decryptBytes(payload, key).equals(plaintext)).toBe(true);
  });

  it('rejects a payload with one flipped ciphertext byte', () => {
    const tampered = Buffer.from(knownAnswer);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff;
    expect(() => decryptBytes(tampered, key)).toThrow(/authentication/);
  });
});
