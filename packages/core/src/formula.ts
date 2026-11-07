export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaError';
  }
}

export type Expr =
  | { type: 'number'; value: number }
  | { type: 'name'; name: string }
  | { type: 'random' }
  | { type: 'normal'; mean: Expr; sd: Expr }
  | { type: 'unary'; expr: Expr }
  | { type: 'binary'; op: '+' | '-' | '*' | '/'; left: Expr; right: Expr };

export type FormulaRng = {
  random(): number;
  normal(mean: number, sd: number): number;
};

type Token =
  | { type: 'number'; value: number }
  | { type: 'name'; value: string }
  | { type: 'op'; value: '+' | '-' | '*' | '/' }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'comma' }
  | { type: 'eof' };

export function parseFormula(source: string): Expr {
  const tokens = tokenize(source);
  let index = 0;

  const peek = (): Token => tokens[index] ?? { type: 'eof' };

  function next(): Token {
    const token = peek();
    index += 1;
    return token;
  }

  function expect(type: Token['type'], message = 'Invalid formula'): Token {
    const token = next();
    if (token.type !== type) {
      throw new FormulaError(message);
    }
    return token;
  }

  function parseExpr(): Expr {
    let left = parseTerm();
    for (;;) {
      const token = peek();
      if (token.type !== 'op' || (token.value !== '+' && token.value !== '-')) {
        return left;
      }
      next();
      left = { type: 'binary', op: token.value, left, right: parseTerm() };
    }
  }

  function parseTerm(): Expr {
    let left = parseUnary();
    for (;;) {
      const token = peek();
      if (token.type !== 'op' || (token.value !== '*' && token.value !== '/')) {
        return left;
      }
      next();
      left = { type: 'binary', op: token.value, left, right: parseUnary() };
    }
  }

  function parseUnary(): Expr {
    const token = peek();
    if (token.type === 'op' && token.value === '-') {
      next();
      return { type: 'unary', expr: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary(): Expr {
    const token = peek();
    if (token.type === 'number') {
      next();
      return { type: 'number', value: token.value };
    }
    if (token.type === 'name') {
      next();
      if (token.value === 'random' && peek().type === 'lparen') {
        next();
        expect('rparen', 'random() takes no arguments');
        return { type: 'random' };
      }
      if (token.value === 'normal' && peek().type === 'lparen') {
        next();
        const mean = parseExpr();
        expect('comma', 'normal() takes a mean and a standard deviation');
        const sd = parseExpr();
        expect('rparen', 'normal() takes a mean and a standard deviation');
        return { type: 'normal', mean, sd };
      }
      return { type: 'name', name: token.value };
    }
    if (token.type === 'lparen') {
      next();
      const expr = parseExpr();
      expect('rparen');
      return expr;
    }
    throw new FormulaError('Invalid formula');
  }

  const expr = parseExpr();
  if (peek().type !== 'eof') {
    throw new FormulaError('Invalid formula');
  }
  return expr;
}

export function formulaNames(expr: Expr): string[] {
  const names = new Set<string>();
  walk(expr, names);
  return [...names].sort();
}

export function evaluateFormula(
  expr: Expr,
  values: Readonly<Record<string, number>>,
  rng?: FormulaRng,
): number | null {
  return evaluate(expr, values, rng);
}

function evaluate(
  expr: Expr,
  values: Readonly<Record<string, number>>,
  rng?: FormulaRng,
): number | null {
  switch (expr.type) {
    case 'number':
      return expr.value;
    case 'name': {
      const value = values[expr.name];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
    case 'random': {
      if (!rng) {
        throw new FormulaError('random() needs a random source');
      }
      const value = rng.random();
      return Number.isFinite(value) ? value : null;
    }
    case 'normal': {
      if (!rng) {
        throw new FormulaError('normal() needs a random source');
      }
      const mean = evaluate(expr.mean, values, rng);
      const sd = evaluate(expr.sd, values, rng);
      if (mean === null || sd === null || sd < 0) {
        return null;
      }
      const value = rng.normal(mean, sd);
      return Number.isFinite(value) ? value : null;
    }
    case 'unary': {
      const value = evaluate(expr.expr, values, rng);
      return value === null ? null : -value;
    }
    case 'binary': {
      const left = evaluate(expr.left, values, rng);
      const right = evaluate(expr.right, values, rng);
      if (left === null || right === null) {
        return null;
      }
      if (expr.op === '+') {
        return left + right;
      }
      if (expr.op === '-') {
        return left - right;
      }
      if (expr.op === '*') {
        return left * right;
      }
      if (right === 0) {
        return null;
      }
      const value = left / right;
      return Number.isFinite(value) ? value : null;
    }
    default:
      return null;
  }
}

function walk(expr: Expr, names: Set<string>): void {
  switch (expr.type) {
    case 'name':
      names.add(expr.name);
      return;
    case 'unary':
      walk(expr.expr, names);
      return;
    case 'binary':
      walk(expr.left, names);
      walk(expr.right, names);
      return;
    case 'normal':
      walk(expr.mean, names);
      walk(expr.sd, names);
      return;
    default:
      return;
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? '';
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1;
      continue;
    }
    if (char >= '0' && char <= '9') {
      const number = scanNumber(source, index);
      tokens.push({ type: 'number', value: number.value });
      index = number.index;
      continue;
    }
    if (isIdentStart(char)) {
      const name = scanName(source, index);
      tokens.push({ type: 'name', value: name.value });
      index = name.index;
      continue;
    }
    if (char === '+' || char === '-' || char === '*' || char === '/') {
      tokens.push({ type: 'op', value: char });
      index += 1;
      continue;
    }
    if (char === '(') {
      tokens.push({ type: 'lparen' });
      index += 1;
      continue;
    }
    if (char === ')') {
      tokens.push({ type: 'rparen' });
      index += 1;
      continue;
    }
    if (char === ',') {
      tokens.push({ type: 'comma' });
      index += 1;
      continue;
    }
    throw new FormulaError('Invalid formula');
  }
  tokens.push({ type: 'eof' });
  return tokens;
}

function scanNumber(source: string, start: number): { value: number; index: number } {
  let index = start;
  while (index < source.length && isDigit(source[index] ?? '')) {
    index += 1;
  }
  if (source[index] === '.' && isDigit(source[index + 1] ?? '')) {
    index += 1;
    while (index < source.length && isDigit(source[index] ?? '')) {
      index += 1;
    }
  }
  const value = Number(source.slice(start, index));
  if (!Number.isFinite(value)) {
    throw new FormulaError('Invalid formula');
  }
  return { value, index };
}

function scanName(source: string, start: number): { value: string; index: number } {
  let index = start + 1;
  while (index < source.length && isIdentPart(source[index] ?? '')) {
    index += 1;
  }
  while (source[index] === '.' && isIdentStart(source[index + 1] ?? '')) {
    index += 2;
    while (index < source.length && isIdentPart(source[index] ?? '')) {
      index += 1;
    }
  }
  return { value: source.slice(start, index), index };
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isIdentStart(char: string): boolean {
  return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '_';
}

function isIdentPart(char: string): boolean {
  return isIdentStart(char) || isDigit(char);
}
