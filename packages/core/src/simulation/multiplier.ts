import { hashSeed, mulberry32, standardNormal } from './random.js';

export const MULTIPLIER_DT_SECONDS = 30;
export const MULTIPLIER_THETA = 1 / 600;
export const MULTIPLIER_SIGMA = 0.00866;
export const MULTIPLIER_MIN = 0.5;
export const MULTIPLIER_MAX = 2;

export function smoothness(virtualUserCount: number): number {
  return clamp(0.15, 1, 1 / Math.sqrt(virtualUserCount / 1000));
}

export function multiplierAt(input: {
  jobId: string;
  startTime: Date;
  windowStart: Date;
  virtualUserCount: number;
}): number {
  const steps = multiplierSteps(input.startTime, input.windowStart);
  return multiplierSeries(input.jobId, steps, input.virtualUserCount).at(-1) ?? 1;
}

export function multiplierSeries(jobId: string, steps: number, virtualUserCount: number): number[] {
  const random = mulberry32(hashSeed(jobId));
  const sigma = MULTIPLIER_SIGMA * smoothness(virtualUserCount);
  const values: number[] = [];
  let current = 1;
  for (let step = 0; step < steps; step += 1) {
    const noise = standardNormal(random);
    const next =
      current +
      MULTIPLIER_THETA * (1 - current) * MULTIPLIER_DT_SECONDS +
      sigma * Math.sqrt(MULTIPLIER_DT_SECONDS) * noise;
    current = clamp(MULTIPLIER_MIN, MULTIPLIER_MAX, next);
    values.push(current);
  }
  return values;
}

export function multiplierSteps(startTime: Date, windowStart: Date): number {
  const elapsed = windowStart.getTime() - startTime.getTime();
  if (elapsed <= 0) {
    return 0;
  }
  return Math.floor(elapsed / (MULTIPLIER_DT_SECONDS * 1000));
}

function clamp(min: number, max: number, value: number): number {
  return Math.min(max, Math.max(min, value));
}
