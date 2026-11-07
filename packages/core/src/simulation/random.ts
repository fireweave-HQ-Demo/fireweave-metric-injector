import { createHash } from 'node:crypto';

export function hashSeed(material: string): number {
  return createHash('sha256').update(material).digest().readUInt32BE(0);
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function standardNormal(random: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) {
    u = random();
  }
  while (v === 0) {
    v = random();
  }
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function openUnit(random: () => number): number {
  let value = 0;
  while (value === 0) {
    value = random();
  }
  return value;
}
