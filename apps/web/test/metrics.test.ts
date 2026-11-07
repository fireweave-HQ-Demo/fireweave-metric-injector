import { describe, expect, it } from 'vitest';
import { emptyMetric, parseTagList, toMetricPayload } from '../src/lib/metrics';

describe('metric drafts', () => {
  it('drops formulas from event metrics and derives dependent names', () => {
    const success = emptyMetric('successes');
    success.formula = '1';
    success.tags = 'service=checkout';
    expect(toMetricPayload(success)).toMatchObject({
      name: 'successes',
      category: 'success',
      formula: null,
      dependsOn: [],
      tags: { service: 'checkout' },
    });

    const rate = emptyMetric('error_rate');
    rate.type = 'gauge';
    rate.category = 'dependent';
    rate.formula = 'errors / (successes + errors)';
    rate.successProbability = '0.2';
    expect(toMetricPayload(rate)).toMatchObject({
      formula: 'errors / (successes + errors)',
      dependsOn: ['errors', 'successes'],
      successProbability: null,
      errorProbability: null,
    });
  });

  it('rejects a tag that is not key=value', () => {
    expect(() => parseTagList('service')).toThrow(/key=value/);
  });
});
