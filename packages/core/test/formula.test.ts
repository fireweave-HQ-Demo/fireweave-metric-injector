import { describe, expect, it } from 'vitest';
import { evaluateFormula, parseFormula } from '../src/formula.js';

describe('metric formulas', () => {
  it('evaluates errors / (successes + errors) against a fixture context', () => {
    const expr = parseFormula('errors / (successes + errors)');
    expect(evaluateFormula(expr, { errors: 2, successes: 8 })).toBeCloseTo(0.2);
    expect(evaluateFormula(expr, { errors: 0, successes: 0 })).toBeNull();
  });

  it('honors precedence, unary minus, and the injected random functions', () => {
    expect(evaluateFormula(parseFormula('1 + 2 * 3'), {})).toBe(7);
    expect(evaluateFormula(parseFormula('(1 + 2) * 3'), {})).toBe(9);
    expect(evaluateFormula(parseFormula('-errors'), { errors: 4 })).toBe(-4);
    const calls: Array<[number, number]> = [];
    const value = evaluateFormula(
      parseFormula('normal(errors, 2) + random()'),
      { errors: 10 },
      {
        random: () => 0.25,
        normal: (mean, sd) => {
          calls.push([mean, sd]);
          return mean + sd;
        },
      },
    );
    expect(calls).toEqual([[10, 2]]);
    expect(value).toBe(12.25);
  });

  it('rejects a formula that does not parse', () => {
    expect(() => parseFormula('errors /')).toThrow(/Invalid formula/);
    expect(() => parseFormula('normal(errors)')).toThrow(/normal/);
  });
});
