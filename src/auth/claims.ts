// Claim-path walker.
//
// Grammar: `.key` / `["quoted key"]` / `[index]` /
// `[start:end]` / `[?(@ OP "value")]` where OP is one of
// `==`, `!=`, `==^`, `^==`, `*==`.
//
// SECURITY: parse errors surface at config-load time via
// `validateRoleClaim`; the authenticator uses the pre-validated path.

// ----- Step shapes -----------------------------------------------------

export type ClaimPathStep =
  | { readonly type: 'key'; readonly key: string }
  | { readonly type: 'index'; readonly index: number }
  | {
      readonly type: 'slice';
      readonly start: number | null;
      readonly end: number | null;
    }
  | {
      readonly type: 'filter';
      readonly operator:
        | 'eq'
        | 'neq'
        | 'startsWith'
        | 'endsWith'
        | 'contains';
      readonly value: string;
    };

// ----- Walker ----------------------------------------------------------

/**
 * Walk a claim path against a JSON value. Returns the resolved leaf
 * or `undefined` when any step misses or the path is malformed.
 *
 * When `parseClaimPath` returns an empty array for a non-empty raw
 * path, that means the path is syntactically invalid. Return
 * `undefined` so the caller falls back to the default/anon role,
 * rather than returning the root value (which would leak the entire
 * JWT payload as the role string).
 */
export function walkClaimPath(value: unknown, rawPath: string): unknown {
  const trimmed = rawPath.trim();
  if (trimmed === '') return value;
  const steps = parseClaimPath(rawPath);
  if (steps.length === 0) return undefined;

  let current: unknown = value;
  for (const step of steps) {
    switch (step.type) {
      case 'key':
        if (
          current === null ||
          typeof current !== 'object' ||
          !(step.key in (current as Record<string, unknown>))
        ) {
          return undefined;
        }
        current = (current as Record<string, unknown>)[step.key];
        break;
      case 'index':
        if (!Array.isArray(current)) return undefined;
        current = (current as readonly unknown[])[step.index];
        break;
      case 'slice':
        if (typeof current !== 'string') return undefined;
        current = sliceClaimString(current, step.start, step.end);
        break;
      case 'filter':
        if (!Array.isArray(current)) return undefined;
        current = (current as readonly unknown[]).find(
          (entry): entry is string =>
            typeof entry === 'string' && matchesClaimFilter(entry, step),
        );
        break;
    }
  }

  return current;
}

// ----- Parser ----------------------------------------------------------

export function parseClaimPath(rawPath: string): ClaimPathStep[] {
  const path = rawPath.trim();
  if (!path) return [];

  const steps: ClaimPathStep[] = [];
  let i = 0;

  while (i < path.length) {
    if (path[i] === '.') {
      i += 1;
      if (path[i] === '"') {
        const end = path.indexOf('"', i + 1);
        if (end < 0) return [];
        steps.push({ type: 'key', key: path.slice(i + 1, end) });
        i = end + 1;
        continue;
      }

      const start = i;
      while (i < path.length && /[A-Za-z0-9_$@-]/.test(path[i]!)) i += 1;
      if (start === i) return [];
      steps.push({ type: 'key', key: path.slice(start, i) });
      continue;
    }

    if (path[i] === '[') {
      if (path.startsWith('[?(@ ', i)) {
        const close = path.indexOf(')]', i);
        if (close < 0) return [];
        const expr = path.slice(i + 3, close).trim();
        const filter = parseClaimFilter(expr);
        if (!filter) return [];
        steps.push(filter);
        i = close + 2;
        continue;
      }

      const close = path.indexOf(']', i);
      if (close < 0) return [];
      const expr = path.slice(i + 1, close).trim();
      if (/^\d+$/.test(expr)) {
        steps.push({ type: 'index', index: Number(expr) });
        i = close + 1;
        continue;
      }

      const sliceMatch = expr.match(/^(-?\d+)?:(-?\d+)?$/);
      if (sliceMatch) {
        steps.push({
          type: 'slice',
          start: sliceMatch[1] ? Number(sliceMatch[1]) : null,
          end: sliceMatch[2] ? Number(sliceMatch[2]) : null,
        });
        i = close + 1;
        continue;
      }

      return [];
    }

    return [];
  }

  return steps;
}

function parseClaimFilter(expr: string): ClaimPathStep | null {
  const match = expr.match(/^(@)\s*(==\^|\^==|\*==|==|!=)\s*"([^"]*)"$/);
  if (!match) return null;

  const operator =
    match[2] === '=='
      ? 'eq'
      : match[2] === '!='
        ? 'neq'
        : match[2] === '^=='
          ? 'startsWith'
          : match[2] === '==^'
            ? 'endsWith'
            : 'contains';

  return { type: 'filter', operator, value: match[3]! };
}

function matchesClaimFilter(
  value: string,
  filter: Extract<ClaimPathStep, { type: 'filter' }>,
): boolean {
  switch (filter.operator) {
    case 'eq':
      return value === filter.value;
    case 'neq':
      return value !== filter.value;
    case 'startsWith':
      return value.startsWith(filter.value);
    case 'endsWith':
      return value.endsWith(filter.value);
    case 'contains':
      return value.includes(filter.value);
  }
}

function sliceClaimString(
  value: string,
  start: number | null,
  end: number | null,
): string {
  const normalize = (index: number | null): number | null => {
    if (index === null) return null;
    return index < 0
      ? Math.max(0, value.length + index)
      : Math.min(value.length, index);
  };
  const normalizedStart = normalize(start) ?? 0;
  const normalizedEnd = normalize(end) ?? value.length;
  if (normalizedStart >= normalizedEnd) return '';
  return value.slice(normalizedStart, normalizedEnd);
}

export function stringifyClaimValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
