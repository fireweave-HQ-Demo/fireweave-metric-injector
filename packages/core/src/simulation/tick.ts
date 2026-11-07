import type { PreparedMetric } from '../definitions.js';
import { evaluateFormula, parseFormula, type Expr, type FormulaRng } from '../formula.js';
import type { MetricPoint } from '../metrics.js';
import { drawInterArrival } from './arrivals.js';
import { instantaneousRate } from './clock.js';
import { multiplierAt } from './multiplier.js';
import { hashSeed, mulberry32, standardNormal } from './random.js';
import { resolveWindow, type SimulationWindow } from './window.js';

const BUCKET_POINT_LIMIT = 2000;
const CHUNK_POINT_LIMIT = 500;

export type SimulationJob = {
  id: string;
  timeZone: string;
  virtualUserCount: number;
  peakRatePerSecond: number;
  successProbability: number;
  errorProbability: number;
  tickIntervalMs: number;
  startTime: Date;
  lastSimulatedAt: Date | null;
};

export type SimulatedTick = {
  window: SimulationWindow;
  lambda: number;
  multiplier: number;
  arrivalCount: number;
  rawPointCount: number;
  points: MetricPoint[];
};

export function simulateTick(input: {
  job: SimulationJob;
  definitions: PreparedMetric[];
  now: Date;
  consecutiveLagTicks?: number;
}): SimulatedTick {
  const window = resolveWindow({
    now: input.now,
    tickIntervalMs: input.job.tickIntervalMs,
    lastSimulatedAt: input.job.lastSimulatedAt,
    consecutiveLagTicks: input.consecutiveLagTicks ?? 0,
  });
  const multiplier = multiplierAt({
    jobId: input.job.id,
    startTime: input.job.startTime,
    windowStart: window.windowStart,
    virtualUserCount: input.job.virtualUserCount,
  });
  const lambda = instantaneousRate({
    at: window.windowStart,
    timeZone: input.job.timeZone,
    peakRatePerSecond: input.job.peakRatePerSecond,
    multiplier,
  });
  const random = mulberry32(hashSeed(`${input.job.id}${window.windowStart.toISOString()}`));
  const formulas = new Map<string, Expr>();
  for (const definition of input.definitions) {
    if (definition.formula) {
      formulas.set(definition.name, parseFormula(definition.formula));
    }
  }
  const rng: FormulaRng = {
    random,
    normal: (mean, sd) => mean + sd * standardNormal(random),
  };
  const generated = generatePoints({
    job: input.job,
    definitions: [...input.definitions].sort((left, right) => left.evalOrder - right.evalOrder),
    formulas,
    window,
    lambda,
    random,
    rng,
  });
  return {
    window,
    lambda,
    multiplier,
    arrivalCount: generated.arrivalCount,
    rawPointCount: generated.points.length,
    points: boundPayload(generated.points),
  };
}

export function boundPayload(points: MetricPoint[], limit = BUCKET_POINT_LIMIT): MetricPoint[] {
  if (points.length <= limit) {
    return points.map(clonePoint);
  }
  const reduced = new Map<string, MetricPoint>();
  const histograms: MetricPoint[] = [];
  for (const point of points) {
    if (point.type === 'histogram') {
      histograms.push(clonePoint(point));
      continue;
    }
    const bucket = Math.floor(point.timestamp.getTime() / 1000);
    const key = JSON.stringify([point.type, point.name, bucket, sortedTags(point.tags)]);
    const existing = reduced.get(key);
    if (!existing) {
      reduced.set(key, clonePoint(point));
      continue;
    }
    if (point.type === 'counter') {
      existing.value += point.value;
      continue;
    }
    if (point.timestamp.getTime() >= existing.timestamp.getTime()) {
      existing.value = point.value;
      existing.timestamp = new Date(point.timestamp.getTime());
    }
  }
  return [...reduced.values(), ...histograms].sort(comparePoints);
}

export function chunkPoints(points: MetricPoint[], size = CHUNK_POINT_LIMIT): MetricPoint[][] {
  const chunks: MetricPoint[][] = [];
  for (let index = 0; index < points.length; index += size) {
    chunks.push(points.slice(index, index + size));
  }
  return chunks;
}

function generatePoints(input: {
  job: SimulationJob;
  definitions: PreparedMetric[];
  formulas: Map<string, Expr>;
  window: SimulationWindow;
  lambda: number;
  random: () => number;
  rng: FormulaRng;
}): { arrivalCount: number; points: MetricPoint[] } {
  const points: MetricPoint[] = [];
  const totals = new Map<string, number>();
  for (const definition of input.definitions) {
    if (definition.category !== 'dependent') {
      totals.set(definition.name, 0);
    }
  }
  let arrivalCount = 0;
  if (input.lambda > 0 && Number.isFinite(input.lambda)) {
    const durationMs = input.window.windowEnd.getTime() - input.window.windowStart.getTime();
    let elapsedMs = 0;
    while (elapsedMs < durationMs) {
      elapsedMs += drawInterArrival(input.random, input.lambda) * 1000;
      if (elapsedMs >= durationMs) {
        break;
      }
      arrivalCount += 1;
      const draw = input.random();
      const timestamp = new Date(input.window.windowStart.getTime() + elapsedMs);
      for (const definition of input.definitions) {
        if (definition.category === 'dependent' || !emits(definition, input.job, draw)) {
          continue;
        }
        points.push(eventPoint(definition, timestamp));
        totals.set(definition.name, (totals.get(definition.name) ?? 0) + 1);
      }
    }
  }
  const values: Record<string, number> = {};
  for (const [name, total] of totals) {
    values[name] = total;
  }
  for (const definition of input.definitions) {
    if (definition.category !== 'dependent') {
      continue;
    }
    const expr = input.formulas.get(definition.name);
    if (!expr) {
      continue;
    }
    const value = evaluateFormula(expr, values, input.rng);
    if (value === null) {
      continue;
    }
    points.push({
      name: definition.name,
      type: definition.type,
      value,
      timestamp: new Date(input.window.windowEnd.getTime()),
      tags: { ...definition.tags },
    });
    values[definition.name] = value;
  }
  return { arrivalCount, points };
}

function emits(definition: PreparedMetric, job: SimulationJob, draw: number): boolean {
  if (definition.category === 'custom') {
    return true;
  }
  const success = definition.successProbability ?? job.successProbability;
  const error = definition.errorProbability ?? job.errorProbability;
  if (definition.category === 'success') {
    return draw < success;
  }
  if (definition.category === 'error') {
    return draw >= success && draw < success + error;
  }
  return false;
}

function eventPoint(definition: PreparedMetric, timestamp: Date): MetricPoint {
  return {
    name: definition.name,
    type: definition.type,
    value: 1,
    timestamp,
    tags: { ...definition.tags },
  };
}

function clonePoint(point: MetricPoint): MetricPoint {
  return { ...point, timestamp: new Date(point.timestamp.getTime()), tags: { ...point.tags } };
}

function sortedTags(tags: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(tags).sort()) {
    sorted[key] = tags[key] ?? '';
  }
  return sorted;
}

function comparePoints(left: MetricPoint, right: MetricPoint): number {
  const time = left.timestamp.getTime() - right.timestamp.getTime();
  if (time !== 0) {
    return time;
  }
  return left.name.localeCompare(right.name);
}
