import { describe, expect, it } from 'vitest';
import { prepareDefinitions, type MetricDraft } from '../src/definitions.js';

function draft(
  overrides: Partial<MetricDraft> & Pick<MetricDraft, 'name' | 'category'>,
): MetricDraft {
  return {
    type: 'counter',
    tags: {},
    dependsOn: [],
    formula: null,
    successProbability: null,
    errorProbability: null,
    ...overrides,
  };
}

const successes = draft({ name: 'successes', category: 'success', tags: { service: 'checkout' } });
const errors = draft({ name: 'errors', category: 'error' });
const errorRate = draft({
  name: 'error_rate',
  type: 'gauge',
  category: 'dependent',
  dependsOn: ['errors', 'successes'],
  formula: 'errors / (successes + errors)',
});

describe('metric definitions', () => {
  it('rejects the cycle a → b → a', () => {
    expect(() =>
      prepareDefinitions([
        draft({ name: 'a', type: 'gauge', category: 'dependent', dependsOn: ['b'], formula: 'b' }),
        draft({ name: 'b', type: 'gauge', category: 'dependent', dependsOn: ['a'], formula: 'a' }),
      ]),
    ).toThrow(/cycle involving a, b/);
  });

  it('puts dependencies after their inputs', () => {
    const prepared = prepareDefinitions([
      errorRate,
      successes,
      errors,
      draft({
        name: 'error_percent',
        type: 'gauge',
        category: 'dependent',
        dependsOn: ['error_rate'],
        formula: 'error_rate * 100',
      }),
    ]);
    const order = Object.fromEntries(prepared.map((metric) => [metric.name, metric.evalOrder]));
    expect(order.errors).toBe(0);
    expect(order.successes).toBe(1);
    expect(order.error_rate).toBeGreaterThan(order.errors ?? 0);
    expect(order.error_rate).toBeGreaterThan(order.successes ?? 0);
    expect(order.error_percent).toBeGreaterThan(order.error_rate ?? 0);
    expect(prepared.map((metric) => metric.evalOrder)).toEqual([0, 1, 2, 3]);
  });

  it('rejects a reserved tag and a value Datadog would split', () => {
    expect(() =>
      prepareDefinitions([
        draft({ name: 'successes', category: 'success', tags: { __name__: 'x' } }),
      ]),
    ).toThrow(/not allowed/);
    expect(() =>
      prepareDefinitions([
        draft({ name: 'successes', category: 'success', tags: { service: 'web,api' } }),
      ]),
    ).toThrow(/invalid value/);
  });
});
