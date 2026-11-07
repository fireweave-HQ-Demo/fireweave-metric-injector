import { FormulaError, formulaNames, parseFormula } from './formula.js';

const METRIC_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}(?:\.[A-Za-z_][A-Za-z0-9_]{0,62})*$/;
const TAG_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const RESERVED_NAMES = new Set(['random', 'normal']);
const RESERVED_TAGS = new Set(['__name__', '__type__', '_timestamp', 'value']);
const MAX_TAGS = 16;

export class MetricDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricDefinitionError';
  }
}

export type MetricDraft = {
  name: string;
  type: 'counter' | 'gauge' | 'histogram';
  category: 'success' | 'error' | 'custom' | 'dependent';
  tags: Record<string, string>;
  dependsOn: string[];
  formula: string | null;
  successProbability: number | null;
  errorProbability: number | null;
};

export type PreparedMetric = MetricDraft & {
  evalOrder: number;
};

export function assertValidTags(tags: Record<string, string>): void {
  const entries = Object.entries(tags);
  if (entries.length > MAX_TAGS) {
    throw new MetricDefinitionError(`A metric can have at most ${MAX_TAGS} tags`);
  }
  for (const [key, value] of entries) {
    if (!TAG_KEY.test(key) || RESERVED_TAGS.has(key)) {
      throw new MetricDefinitionError(`Tag ${key} is not allowed`);
    }
    if (value.length === 0 || value.length > 200 || hasForbiddenTagChar(value)) {
      throw new MetricDefinitionError(`Tag ${key} has an invalid value`);
    }
  }
}

export function prepareDefinitions(inputs: MetricDraft[]): PreparedMetric[] {
  if (inputs.length === 0) {
    throw new MetricDefinitionError('At least one metric is required');
  }
  const byName = new Map<string, MetricDraft>();
  for (const input of inputs) {
    validateDraft(input);
    if (byName.has(input.name)) {
      throw new MetricDefinitionError(`Metric name is duplicated: ${input.name}`);
    }
    byName.set(input.name, input);
  }
  for (const input of inputs) {
    validateDependencies(input, byName);
  }
  const order = evaluationOrder(inputs);
  return inputs
    .map((input) => {
      const evalOrder = order.get(input.name);
      if (evalOrder === undefined) {
        throw new MetricDefinitionError('Metric definitions contain a cycle');
      }
      return { ...input, evalOrder };
    })
    .sort((left, right) => left.evalOrder - right.evalOrder);
}

function validateDraft(input: MetricDraft): void {
  if (input.name.length > 128 || !METRIC_NAME.test(input.name) || RESERVED_NAMES.has(input.name)) {
    throw new MetricDefinitionError(`Metric name ${input.name} is not allowed`);
  }
  assertValidTags(input.tags);
  assertProbability(input.successProbability, input.name);
  assertProbability(input.errorProbability, input.name);
  if (
    input.successProbability !== null &&
    input.errorProbability !== null &&
    input.successProbability + input.errorProbability > 1 + 1e-9
  ) {
    throw new MetricDefinitionError(`Probabilities for ${input.name} must sum to at most 1`);
  }
  if (input.category === 'dependent') {
    if (!input.formula) {
      throw new MetricDefinitionError(`A dependent metric needs a formula: ${input.name}`);
    }
    if (input.successProbability !== null || input.errorProbability !== null) {
      throw new MetricDefinitionError(`A dependent metric ignores probabilities: ${input.name}`);
    }
    return;
  }
  if (input.formula) {
    throw new MetricDefinitionError(`Only a dependent metric can have a formula: ${input.name}`);
  }
  if (input.dependsOn.length > 0) {
    throw new MetricDefinitionError(
      `Only a dependent metric can depend on other metrics: ${input.name}`,
    );
  }
}

function validateDependencies(input: MetricDraft, byName: Map<string, MetricDraft>): void {
  if (input.category !== 'dependent') {
    return;
  }
  const seen = new Set<string>();
  for (const name of input.dependsOn) {
    if (name === input.name) {
      throw new MetricDefinitionError(`Metric ${input.name} cannot depend on itself`);
    }
    if (!byName.has(name)) {
      throw new MetricDefinitionError(`dependsOn names a metric that is not on this job: ${name}`);
    }
    if (seen.has(name)) {
      throw new MetricDefinitionError(`dependsOn repeats ${name} on ${input.name}`);
    }
    seen.add(name);
  }
  let referenced: string[];
  try {
    referenced = formulaNames(parseFormula(input.formula ?? ''));
  } catch (error) {
    if (error instanceof FormulaError) {
      throw new MetricDefinitionError(`Invalid formula for ${input.name}`);
    }
    throw error;
  }
  const expected = [...input.dependsOn].sort();
  if (
    expected.length !== referenced.length ||
    expected.some((name, index) => name !== referenced[index])
  ) {
    throw new MetricDefinitionError(
      `Formula for ${input.name} must reference exactly its dependsOn metrics`,
    );
  }
}

function evaluationOrder(inputs: MetricDraft[]): Map<string, number> {
  const indegree = new Map(inputs.map((input) => [input.name, 0]));
  const dependents = new Map(inputs.map((input) => [input.name, [] as string[]]));
  for (const input of inputs) {
    for (const name of input.dependsOn) {
      indegree.set(input.name, (indegree.get(input.name) ?? 0) + 1);
      dependents.get(name)?.push(input.name);
    }
  }
  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([name]) => name);
  ready.sort();
  const ordered: string[] = [];
  while (ready.length > 0) {
    const name = ready.shift();
    if (!name) {
      break;
    }
    ordered.push(name);
    for (const child of dependents.get(name) ?? []) {
      const degree = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, degree);
      if (degree === 0) {
        ready.push(child);
      }
    }
    ready.sort();
  }
  if (ordered.length !== inputs.length) {
    const stuck = inputs.map((input) => input.name).filter((name) => !ordered.includes(name));
    throw new MetricDefinitionError(
      `Metric definitions contain a cycle involving ${stuck.sort().join(', ')}`,
    );
  }
  return new Map(ordered.map((name, index) => [name, index]));
}

function hasForbiddenTagChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || value[index] === ',') {
      return true;
    }
  }
  return false;
}

function assertProbability(value: number | null, name: string): void {
  if (value === null) {
    return;
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new MetricDefinitionError(`Probability for ${name} must be between 0 and 1`);
  }
}
