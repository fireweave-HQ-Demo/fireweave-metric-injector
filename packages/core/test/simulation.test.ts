import { describe, expect, it } from 'vitest';
import type { PreparedMetric } from '../src/definitions.js';
import {
  PARETO_ALPHA,
  boundPayload,
  chunkPoints,
  diurnal,
  drawExponential,
  drawInterArrival,
  drawPareto,
  hashSeed,
  mulberry32,
  multiplierSeries,
  paretoMinimum,
  resolveWindow,
  simulateTick,
  weekendBlend,
  type SimulationJob,
} from '../src/index.js';

const jobId = '11111111-1111-4111-8111-111111111111';
const fridayAfternoon = new Date('2026-01-02T14:00:00.000Z');

function metric(
  overrides: Partial<PreparedMetric> & Pick<PreparedMetric, 'name' | 'category'>,
): PreparedMetric {
  return {
    type: 'counter',
    tags: {},
    dependsOn: [],
    formula: null,
    evalOrder: 0,
    successProbability: null,
    errorProbability: null,
    ...overrides,
  };
}

function job(overrides: Partial<SimulationJob> = {}): SimulationJob {
  return {
    id: jobId,
    timeZone: 'UTC',
    virtualUserCount: 1000,
    peakRatePerSecond: 100,
    successProbability: 0.8,
    errorProbability: 0.15,
    tickIntervalMs: 5000,
    startTime: fridayAfternoon,
    lastSimulatedAt: null,
    ...overrides,
  };
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleVariance(values: number[]): number {
  const mean = average(values);
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
}

function kolmogorovSmirnov(samples: number[], cdf: (value: number) => number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  let statistic = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const theoretical = cdf(sorted[index] ?? 0);
    statistic = Math.max(
      statistic,
      Math.abs((index + 1) / sorted.length - theoretical),
      Math.abs(index / sorted.length - theoretical),
    );
  }
  return statistic;
}

describe('diurnal curve and weekend ramp', () => {
  it('peaks at 1 at 14:00 and sits near the floor at 03:00', () => {
    expect(diurnal(14)).toBeCloseTo(1, 12);
    expect(diurnal(3)).toBeGreaterThan(0.15);
    expect(diurnal(3)).toBeLessThan(0.2);
    expect(diurnal(3)).toBeLessThan(diurnal(14));
  });

  it('is continuous across midnight', () => {
    expect(diurnal(0)).toBeCloseTo(diurnal(24), 12);
    expect(Math.abs(diurnal(23.99) - diurnal(0.01))).toBeLessThan(0.01);
  });

  it('ramps the weekend factor across Friday and Sunday night', () => {
    expect(weekendBlend(new Date('2026-01-02T22:00:00.000Z'), 'UTC')).toBe(1);
    expect(weekendBlend(new Date('2026-01-03T02:00:00.000Z'), 'UTC')).toBe(0.45);
    expect(weekendBlend(new Date('2026-01-03T00:00:00.000Z'), 'UTC')).toBeCloseTo(0.725, 12);
    expect(weekendBlend(new Date('2026-01-02T23:30:00.000Z'), 'UTC')).toBeCloseTo(
      1 + 0.25 * (0.45 - 1),
      12,
    );
    expect(weekendBlend(new Date('2026-01-05T00:00:00.000Z'), 'UTC')).toBeCloseTo(0.725, 12);
    expect(weekendBlend(new Date('2026-01-05T02:00:00.000Z'), 'UTC')).toBe(1);

    const fridayEveningNewYork = new Date('2026-01-03T03:00:00.000Z');
    expect(weekendBlend(fridayEveningNewYork, 'America/New_York')).toBe(1);
    expect(weekendBlend(fridayEveningNewYork, 'UTC')).toBe(0.45);
  });
});

describe('multiplier', () => {
  it('is less volatile at 100000 users than at 1000, and lambda changes with it', () => {
    const calm = multiplierSeries(jobId, 4000, 100_000);
    const wild = multiplierSeries(jobId, 4000, 1000);
    expect(sampleVariance(calm)).toBeLessThan(sampleVariance(wild));

    const later = new Date(fridayAfternoon.getTime() + 86_400_000);
    const shared = {
      startTime: fridayAfternoon,
      lastSimulatedAt: later,
      peakRatePerSecond: 10,
      tickIntervalMs: 1000,
    };
    const calmTick = simulateTick({
      job: job({ ...shared, virtualUserCount: 100_000 }),
      definitions: [metric({ name: 'successes', category: 'success' })],
      now: later,
    });
    const wildTick = simulateTick({
      job: job({ ...shared, virtualUserCount: 1000 }),
      definitions: [metric({ name: 'successes', category: 'success' })],
      now: later,
    });
    expect(calmTick.lambda).not.toBe(wildTick.lambda);
    expect(sampleVariance(calm.map((value) => 10 * value))).toBeLessThan(
      sampleVariance(wild.map((value) => 10 * value)),
    );
  });
});

describe('inter-arrivals', () => {
  it('matches the exponential and Pareto distributions', () => {
    const lambda = 4;
    const count = 4000;
    const critical = 1.63 / Math.sqrt(count);
    const exponentialRandom = mulberry32(hashSeed('exponential-ks'));
    const paretoRandom = mulberry32(hashSeed('pareto-ks'));
    const exponential = Array.from({ length: count }, () =>
      drawExponential(exponentialRandom, lambda),
    );
    const pareto = Array.from({ length: count }, () => drawPareto(paretoRandom, lambda));
    const xmin = paretoMinimum(lambda);
    expect(kolmogorovSmirnov(exponential, (value) => 1 - Math.exp(-lambda * value))).toBeLessThan(
      critical,
    );
    expect(
      kolmogorovSmirnov(pareto, (value) => (value < xmin ? 0 : 1 - (xmin / value) ** PARETO_ALPHA)),
    ).toBeLessThan(critical);
  });

  it('keeps the mixture mean at 1/lambda with variance below the exponential', () => {
    const lambda = 4;
    const count = 20_000;
    const random = mulberry32(hashSeed('mixture'));
    const samples = Array.from({ length: count }, () => drawInterArrival(random, lambda));
    const mean = 1 / lambda;
    expect(Math.abs(average(samples) - mean)).toBeLessThan(
      5 * Math.sqrt(sampleVariance(samples) / count),
    );
    const exponentialVariance = 1 / lambda ** 2;
    const paretoVariance = 0.8 / lambda ** 2;
    const variance = sampleVariance(samples);
    expect(variance).toBeGreaterThan(paretoVariance);
    expect(variance).toBeLessThan(exponentialVariance);
  });

  it('does not make per-second counts overdispersed', () => {
    const lambda = 5;
    const seconds = 8000;
    const counts = Array.from({ length: seconds }, () => 0);
    const random = mulberry32(hashSeed('counts'));
    let elapsed = 0;
    while (elapsed < seconds) {
      elapsed += drawInterArrival(random, lambda);
      const bucket = Math.floor(elapsed);
      if (bucket < seconds) {
        counts[bucket] = (counts[bucket] ?? 0) + 1;
      }
    }
    const mean = average(counts);
    expect(sampleVariance(counts)).toBeLessThan(mean * 1.03);
    expect(mean).toBeGreaterThan(lambda * 0.9);
    expect(mean).toBeLessThan(lambda * 1.1);
  });
});

describe('tick simulation', () => {
  const successes = metric({
    name: 'successes',
    category: 'success',
    tags: { service: 'checkout' },
    evalOrder: 0,
  });
  const errors = metric({ name: 'errors', category: 'error', evalOrder: 1 });
  const errorRate = metric({
    name: 'error_rate',
    type: 'gauge',
    category: 'dependent',
    dependsOn: ['errors', 'successes'],
    formula: 'errors / (successes + errors)',
    evalOrder: 2,
  });

  it('repeats a window from the same seed and clock', () => {
    const input = {
      job: job(),
      definitions: [successes, errors, errorRate],
      now: fridayAfternoon,
    };
    const first = simulateTick(input);
    const second = simulateTick(input);
    expect(first.points.map(stamp)).toEqual(second.points.map(stamp));
    expect(first.arrivalCount).toBe(second.arrivalCount);
    expect(first.lambda).toBeCloseTo(100, 8);
  });

  it('matches success and error probabilities and evaluates the rate formula', () => {
    const result = simulateTick({
      job: job({ tickIntervalMs: 10_000 }),
      definitions: [successes, errors, errorRate],
      now: fridayAfternoon,
    });
    const successCount = sum(result.points, 'successes');
    const errorCount = sum(result.points, 'errors');
    const arrivals = result.arrivalCount;
    expect(Math.abs(successCount / arrivals - 0.8)).toBeLessThan(
      5 * Math.sqrt((0.8 * 0.2) / arrivals),
    );
    expect(Math.abs(errorCount / arrivals - 0.15)).toBeLessThan(
      5 * Math.sqrt((0.15 * 0.85) / arrivals),
    );
    const rate = result.points.find((point) => point.name === 'error_rate');
    expect(rate?.timestamp.getTime()).toBe(result.window.windowEnd.getTime());
    expect(rate?.value).toBeCloseTo(errorCount / (successCount + errorCount), 8);
    expect(
      result.points.every(
        (point) => point.name !== 'successes' || point.tags.service === 'checkout',
      ),
    ).toBe(true);
  });

  it('emits nothing for a rate whose denominator is zero', () => {
    const result = simulateTick({
      job: job({
        successProbability: 0,
        errorProbability: 0,
        peakRatePerSecond: 40,
        tickIntervalMs: 2000,
      }),
      definitions: [successes, errors, errorRate],
      now: fridayAfternoon,
    });
    expect(result.arrivalCount).toBeGreaterThan(0);
    expect(result.points.find((point) => point.name === 'error_rate')).toBeUndefined();
  });

  it('buckets a tick above 2000 points without changing the counter total', () => {
    const result = simulateTick({
      job: job({
        peakRatePerSecond: 2000,
        successProbability: 1,
        errorProbability: 0,
        tickIntervalMs: 2000,
      }),
      definitions: [successes],
      now: fridayAfternoon,
    });
    expect(result.rawPointCount).toBeGreaterThan(2000);
    expect(result.points.length).toBeLessThan(result.rawPointCount);
    expect(sum(result.points, 'successes')).toBe(result.rawPointCount);
    expect(result.window.windowEnd.getTime() - result.window.windowStart.getTime()).toBe(2000);
  });

  it('keeps the last gauge sample in a one-second bucket and chunks sends', () => {
    const second = new Date('2026-01-02T14:00:01.500Z');
    const later = new Date('2026-01-02T14:00:01.800Z');
    const counters = Array.from({ length: 5 }, (_, index) => ({
      name: 'successes',
      type: 'counter' as const,
      value: 1,
      timestamp: new Date(second.getTime() + index),
      tags: { service: 'checkout' },
    }));
    const bounded = boundPayload(
      [
        { name: 'depth', type: 'gauge', value: 1, timestamp: second, tags: {} },
        { name: 'depth', type: 'gauge', value: 7, timestamp: later, tags: {} },
        ...counters,
      ],
      1,
    );
    expect(bounded.find((point) => point.name === 'depth')).toMatchObject({ value: 7 });
    expect(sum(bounded, 'successes')).toBe(5);

    const chunks = chunkPoints(
      Array.from({ length: 1001 }, (_, index) => ({
        name: 'successes',
        type: 'counter' as const,
        value: 1,
        timestamp: new Date(index),
        tags: {},
      })),
    );
    expect(chunks.map((chunk) => chunk.length)).toEqual([500, 500, 1]);
  });

  it('advances a 5-second window by 5000 milliseconds', () => {
    const first = resolveWindow({
      now: fridayAfternoon,
      tickIntervalMs: 5000,
      lastSimulatedAt: null,
      consecutiveLagTicks: 0,
    });
    expect(first.windowEnd.getTime() - first.windowStart.getTime()).toBe(5000);
    expect(first.windowEnd.getTime()).toBe(fridayAfternoon.getTime() + 5000);

    const steady = resolveWindow({
      now: new Date(fridayAfternoon.getTime() + 1000),
      tickIntervalMs: 5000,
      lastSimulatedAt: fridayAfternoon,
      consecutiveLagTicks: 2,
    });
    expect(steady.lagging).toBe(false);
    expect(steady.consecutiveLagTicks).toBe(0);
    expect(steady.windowEnd.getTime()).toBe(fridayAfternoon.getTime() + 5000);

    const lagged = resolveWindow({
      now: new Date(fridayAfternoon.getTime() + 31_000),
      tickIntervalMs: 5000,
      lastSimulatedAt: fridayAfternoon,
      consecutiveLagTicks: 2,
    });
    expect(lagged.lagging).toBe(true);
    expect(lagged.windowStart.getTime()).toBe(fridayAfternoon.getTime() + 31_000);
    expect(lagged.windowEnd.getTime() - lagged.windowStart.getTime()).toBe(5000);
    expect(lagged.consecutiveLagTicks).toBe(3);
    expect(lagged.autoFail).toBe(true);
  });
});

function stamp(point: { name: string; value: number; timestamp: Date }): string {
  return `${point.name}:${point.value}:${point.timestamp.toISOString()}`;
}

function sum(points: Array<{ name: string; value: number }>, name: string): number {
  return points
    .filter((point) => point.name === name)
    .reduce((total, point) => total + point.value, 0);
}
