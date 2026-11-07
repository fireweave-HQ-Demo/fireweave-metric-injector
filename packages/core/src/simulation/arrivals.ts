import { openUnit } from './random.js';

export const PARETO_ALPHA = 2.5;
export const PARETO_WEIGHT = 0.15;
export const EXPONENTIAL_WEIGHT = 0.85;

export function drawExponential(random: () => number, lambda: number): number {
  return -Math.log(openUnit(random)) / lambda;
}

export function paretoMinimum(lambda: number): number {
  return 0.6 / lambda;
}

export function drawPareto(random: () => number, lambda: number): number {
  const xmin = paretoMinimum(lambda);
  return xmin / openUnit(random) ** (1 / PARETO_ALPHA);
}

export function drawInterArrival(random: () => number, lambda: number): number {
  if (random() < EXPONENTIAL_WEIGHT) {
    return drawExponential(random, lambda);
  }
  return drawPareto(random, lambda);
}
