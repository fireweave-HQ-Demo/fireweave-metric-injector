import { FormulaError, formulaNames, parseFormula } from '@fireweave/core/formula';

export type MetricDraft = {
  key: string;
  name: string;
  type: 'counter' | 'gauge' | 'histogram';
  category: 'success' | 'error' | 'custom' | 'dependent';
  tags: string;
  formula: string;
  successProbability: string;
  errorProbability: string;
  evalOrder?: number;
};

export type MetricPayload = {
  name: string;
  type: MetricDraft['type'];
  category: MetricDraft['category'];
  tags: Record<string, string>;
  dependsOn: string[];
  formula: string | null;
  successProbability: number | null;
  errorProbability: number | null;
};

export function emptyMetric(name = 'successes'): MetricDraft {
  return {
    key: crypto.randomUUID(),
    name,
    type: 'counter',
    category: 'success',
    tags: '',
    formula: '',
    successProbability: '',
    errorProbability: '',
  };
}

export function parseTagList(value: string): Record<string, string> {
  const tags: Record<string, string> = {};
  if (value.trim().length === 0) {
    return tags;
  }
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const splitAt = trimmed.indexOf('=');
    const key = splitAt === -1 ? '' : trimmed.slice(0, splitAt).trim();
    const tagValue = splitAt === -1 ? '' : trimmed.slice(splitAt + 1).trim();
    if (key.length === 0 || tagValue.length === 0) {
      throw new Error('Write tags as key=value, separated by commas');
    }
    tags[key] = tagValue;
  }
  return tags;
}

export function formatTags(tags: Record<string, string>): string {
  return Object.entries(tags)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

export function formulaDependsOn(formula: string): { names: string[]; error: string | null } {
  const trimmed = formula.trim();
  if (trimmed.length === 0) {
    return { names: [], error: 'A dependent metric needs a formula' };
  }
  try {
    return { names: formulaNames(parseFormula(trimmed)), error: null };
  } catch (error) {
    if (error instanceof FormulaError) {
      return { names: [], error: error.message };
    }
    return { names: [], error: 'Formula is invalid' };
  }
}

function optionalProbability(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error('Probabilities must be numbers from 0 to 1');
  }
  return parsed;
}

export function toMetricPayload(draft: MetricDraft): MetricPayload {
  const dependent = draft.category === 'dependent';
  const formula = dependent ? draft.formula.trim() : '';
  const depends = dependent ? formulaDependsOn(formula) : { names: [], error: null };
  if (depends.error) {
    throw new Error(depends.error);
  }
  return {
    name: draft.name.trim(),
    type: draft.type,
    category: draft.category,
    tags: parseTagList(draft.tags),
    dependsOn: depends.names,
    formula: dependent ? formula : null,
    successProbability: dependent ? null : optionalProbability(draft.successProbability),
    errorProbability: dependent ? null : optionalProbability(draft.errorProbability),
  };
}

export function draftsFromDefinitions(
  definitions: Array<{
    name: string;
    type: MetricDraft['type'];
    category: MetricDraft['category'];
    tags: Record<string, string>;
    formula: string | null;
    evalOrder: number;
    successProbability: number | null;
    errorProbability: number | null;
  }>,
): MetricDraft[] {
  return definitions.map((definition) => ({
    key: crypto.randomUUID(),
    name: definition.name,
    type: definition.type,
    category: definition.category,
    tags: formatTags(definition.tags),
    formula: definition.formula ?? '',
    successProbability:
      definition.successProbability === null ? '' : String(definition.successProbability),
    errorProbability:
      definition.errorProbability === null ? '' : String(definition.errorProbability),
    evalOrder: definition.evalOrder,
  }));
}
